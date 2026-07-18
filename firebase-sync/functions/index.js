"use strict";

/* =============================================================================
  syncStudentIdentity — Cloud Functions desplegadas en `estudiantes-musicala`.

  Flujo: Formulario / Lista (estudiantes-musicala/estudiantes/{studentId})
    → publica identidad resumida en:
        - rip-musicala/students/{studentId}
        - bitacoras-de-clase/students/{studentId}
    → mantiene acceso users/{email} en bitacoras-de-clase.

  Contrato:
  - El studentId canónico es el ID del documento en `estudiantes`.
    Si el contenido trae un studentId distinto, manda el ID de la ruta
    (sourceDocId) y la inconsistencia queda registrada.
  - Lista es dueña de la IDENTIDAD (nombre, correos, contactId, procesos).
    Lista NO es dueña del estado operativo: los campos del mapa `rip` y
    `users.active` gobernados por RIP nunca se sobrescriben desde aquí.
  - Todas las escrituras son merges idempotentes: reejecutar no duplica.

  IAM requerido (ver DEPLOYMENT.md):
  - La cuenta de servicio de estas funciones necesita roles/datastore.user
    sobre rip-musicala y bitacoras-de-clase.
============================================================================= */

const crypto = require("crypto");
const admin = require("firebase-admin");
const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { HttpsError, onCall, onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { buildHistoricalDirectory } = require("./historical-directory");

/*
  Secreto para la huella HMAC del documento de identidad.
  Se crea con: firebase functions:secrets:set DOC_INDEX_SECRET --project estudiantes-musicala
  Nunca se guarda en el repositorio ni en .env.
*/
const DOC_INDEX_SECRET = defineSecret("DOC_INDEX_SECRET");
const BACKFILL_IDENTITY_TOKEN = defineSecret("BACKFILL_IDENTITY_TOKEN");
const LEGACY_APPS_SCRIPT_URL = defineSecret("LEGACY_APPS_SCRIPT_URL");
const LEGACY_APPS_SCRIPT_TOKEN = defineSecret("LEGACY_APPS_SCRIPT_TOKEN");

const SOURCE_PROJECT_ID = "estudiantes-musicala";
const BITACORAS_PROJECT_ID = "bitacoras-de-clase";
const RIP_PROJECT_ID = "rip-musicala";

const SOURCE_STUDENTS_COLLECTION = "estudiantes";
const DOCUMENT_INDEX_COLLECTION = "student_document_index";
const TARGET_STUDENTS_COLLECTION = "students";
const TARGET_USERS_COLLECTION = "users";
const SYNC_META_COLLECTION = "app_config";
const SYNC_META_DOC = "student_sync_status";
const SYNC_LOGS_COLLECTION = "sync_logs";
const INTEGRATION_JOBS_COLLECTION = "integration_jobs";
const REGISTRATION_EVENTS_COLLECTION = "registration_events";
const RATE_LIMIT_COLLECTION = "registration_rate_limits";

const STUDENT_DIRECTORY_EMAILS = new Set([
  "alekcaballeromusic@gmail.com",
  "catalina.medina.leal@gmail.com",
  "adminmusicala@gmail.com",
  "musicalaasesor@gmail.com",
]);
// La unificación cambia la visibilidad de registros fuente y por eso se
// restringe a quienes hoy pueden editar el directorio, no a todo lector.
const STUDENT_DIRECTORY_MERGE_EMAILS = new Set([
  "alekcaballeromusic@gmail.com",
  "catalina.medina.leal@gmail.com",
]);
const HISTORICAL_DIRECTORY_CACHE_MS = 5 * 60 * 1000;
let historicalDirectoryCache = { expiresAt: 0, payload: null };

const SCHEMA_VERSION = 2;

admin.initializeApp({ projectId: SOURCE_PROJECT_ID });

const bitacorasApp = admin.initializeApp(
  { projectId: BITACORAS_PROJECT_ID },
  "bitacoras-target"
);
const ripApp = admin.initializeApp(
  { projectId: RIP_PROJECT_ID },
  "rip-target"
);

const sourceDb = admin.firestore();
const bitacorasDb = bitacorasApp.firestore();
const ripDb = ripApp.firestore();

// Permite apagar un destino sin redeploy de código (p. ej. mientras se
// otorgan permisos IAM sobre rip-musicala).
function ripTargetEnabled() {
  return String(process.env.RIP_TARGET_ENABLED || "true").toLowerCase() !== "false";
}

/* =========================
   Utilidades
========================= */

function toText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeText(value) {
  return toText(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function slugify(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function uniqueTexts(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(toText).filter(Boolean))].sort();
}

function firstText(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const joined = value.map(toText).filter(Boolean).join(" ");
      if (joined) return joined;
      continue;
    }
    const text = toText(value);
    if (text) return text;
  }
  return "";
}

function extractEmails(...values) {
  const text = values.flat(Infinity).map(toText).filter(Boolean).join(" ");
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return uniqueTexts(matches.map((email) => email.toLowerCase().replace(/\s+/g, "")));
}

function buildLegacyStudentKey(name, sourceRow) {
  const safeRow = toText(sourceRow);
  if (!name || !safeRow) return "";
  return `stu_${slugify(name)}_${safeRow}`;
}

/* =========================
   Datos sensibles del documento de identidad

   El número de documento es PRIVADO: nunca viaja como alias a RIP,
   Bitácoras, usuarios ni logs. Estas utilidades lo detectan y lo filtran
   de cualquier lista de identificadores.
========================= */

function collectDocumentValues(raw) {
  const values = new Set();
  for (const field of [
    raw.studentDocument,
    raw.documento,
    raw.identificacion,
    raw.numeroDocumento,
    raw.no_de_documento_estudiante,
  ]) {
    const text = toText(field).toUpperCase().replace(/\s+/g, "");
    if (text) {
      values.add(text);
      values.add(text.replace(/^(CC|TI|RC|CE|PAS|NIT|PPT)/, ""));
    }
  }
  values.delete("");
  return values;
}

// Un alias "parece documento" si es tipo+dígitos o solo dígitos largos.
// sourceRow (números de fila) tiene pocos dígitos, así que no se ve afectado.
function looksLikeDocumentNumber(value) {
  const text = toText(value).toUpperCase().replace(/\s+/g, "");
  return /^(CC|TI|RC|CE|PAS|NIT|PPT)?\d{5,}$/.test(text) || /^(RC|PAS)[A-Z0-9-]{5,}$/.test(text);
}

function filterSensitiveAliases(values, documentValues) {
  const docs = documentValues || new Set();
  return (Array.isArray(values) ? values : []).filter((value) => {
    const text = toText(value).toUpperCase().replace(/\s+/g, "");
    if (!text) return false;
    if (docs.has(text)) return false;
    if (looksLikeDocumentNumber(text)) return false;
    return true;
  });
}

// Documento normalizado para la huella HMAC: TIPO+NÚMERO sin espacios,
// en mayúsculas. No se registra en logs ni en mensajes de error.
function normalizeDocumentForFingerprint(raw) {
  for (const field of [
    raw.studentDocument,
    raw.documento,
    raw.identificacion,
    raw.numeroDocumento,
    raw.no_de_documento_estudiante,
  ]) {
    const text = toText(field).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (text.length >= 5) return text;
  }
  return "";
}

function buildDocumentFingerprint(normalizedDocument, secretValue) {
  if (!normalizedDocument || !secretValue) return "";
  return crypto
    .createHmac("sha256", secretValue)
    .update(`musicala:doc:v2:${normalizedDocument}`)
    .digest("hex");
}

/* =========================
   Política transicional de estado (Lista)

   Mientras RIP → Bitácoras no haya publicado estado para un estudiante,
   Lista conserva el comportamiento previo (estado del sheet → active).
   Cuando el doc destino ya tiene `rip.statusVersion`, RIP manda y Lista
   deja de escribir estado/active. La política oficial de permisos vive en
   las funciones de rip-musicala (derivePermissionsFromStatus).
========================= */

function isAllowedStudentStatus(status) {
  const safeStatus = normalizeText(status).replace(/[‐-―−]/g, "-");
  if (!safeStatus) return true;

  if (
    safeStatus === "activo" ||
    safeStatus.startsWith("activo no registro") ||
    safeStatus.startsWith("activo en pausa")
  ) {
    return true;
  }

  if (safeStatus.startsWith("inactivo en pausa")) {
    return /1\s*-\s*3/.test(safeStatus) || /1\s+a\s+3/.test(safeStatus);
  }

  return false;
}

/* =========================
   Normalización de procesos (igual que antes)
========================= */

function normalizeProcesses(raw, studentKey, name) {
  const rawProcesses = Array.isArray(raw.processes)
    ? raw.processes
    : Array.isArray(raw.procesos)
      ? raw.procesos
      : [];

  if (rawProcesses.length) {
    return rawProcesses
      .map((process, index) => {
        const area = firstText(process.arte, process.area, process.curso);
        const detail = firstText(
          process.detalle,
          process.instrumento,
          process.enfasis,
          process.estilo
        );
        const label = firstText(process.label, process.programa) ||
          [area, detail].filter(Boolean).join(" - ") ||
          `Proceso ${index + 1}`;
        if (!area && !detail && !label) return null;

        return {
          processKey: firstText(process.processKey, process.id) ||
            `proc_${slugify(studentKey || name)}_${slugify(area || label)}_${slugify(detail || label)}_${index + 1}`,
          arte: area,
          area,
          detalle: detail,
          instrumento: detail,
          label,
          docente: firstText(process.docente, process.teacher),
          teacher: firstText(process.teacher, process.docente),
        };
      })
      .filter(Boolean);
  }

  const area = firstText(raw.area, raw.arte, raw.course, raw.curso, raw.programa);
  const detail = firstText(
    raw.instrumento,
    raw.instrument,
    raw.detalle,
    raw.emphasis,
    raw.enfasis,
    raw.style,
    raw.estilo
  );
  if (!area && !detail) return [];

  return [{
    processKey: `proc_${slugify(studentKey || name)}_${slugify(area || "proceso")}_${slugify(detail || "general")}_1`,
    arte: area,
    area,
    detalle: detail,
    instrumento: detail,
    label: [area, detail].filter(Boolean).join(" - ") || "Proceso",
    docente: firstText(raw.docente, raw.teacher),
    teacher: firstText(raw.teacher, raw.docente),
  }];
}

/* =========================
   Normalización de identidad
========================= */

function normalizeStudent(raw, sourceDocId) {
  const name = firstText(
    raw.studentName,
    raw.nombre,
    raw.name,
    raw.nombreCompleto,
    raw.estudiante,
    raw.fullName,
    raw.displayName,
    raw.nombres_y_apellidos_estudiante,
    raw.nombres_y_apellidos_estudiante_2
  );

  if (!name || !sourceDocId) return null;

  const sourceRow = firstText(raw.sourceRow, raw.rowNumber, raw.numeroFila, raw.fila);
  const legacyStudentKey = buildLegacyStudentKey(name, sourceRow);

  // studentId canónico: el ID del documento de la ruta es la autoridad final.
  const declaredStudentId = toText(raw.studentId);
  const canonicalId = sourceDocId;
  const idConflict = Boolean(declaredStudentId && declaredStudentId !== sourceDocId);

  // ID primario con el criterio ANTIGUO del sync: sirve solo para encontrar y
  // marcar el documento espejo legado en Bitácoras (no como identidad).
  const legacyPrimaryId = firstText(
    raw.studentKey,
    declaredStudentId,
    raw.estudianteId,
    legacyStudentKey,
    raw.id,
    raw.studentDocument,
    raw.documento,
    raw.identificacion,
    raw.numeroDocumento,
    raw.no_de_documento_estudiante,
    sourceDocId
  );

  const emails = extractEmails(
    raw.email,
    raw.correo,
    raw.correoElectronico,
    raw.mail,
    raw.studentEmail,
    raw.emailEstudiante,
    raw.correoEstudiante,
    raw.emailAcudiente,
    raw.correoAcudiente,
    raw.acudienteEmail,
    raw.correo_electronico_envio_de_guias_e_informacion_adicional,
    raw.emails,
    raw.correos,
    raw.alternateEmails,
    raw.allEmails,
    raw.linkedEmails
  );

  // Aliases heredados NO SENSIBLES: contactId, IDs Firestore antiguos,
  // legacyStudentKey y name keys de transición. El documento de identidad
  // NUNCA se publica como alias (ni aquí ni en RIP/usuarios/logs); los
  // registros históricos llaveados por documento los resuelve la migración
  // y los limpia sanitize-sensitive-aliases.js.
  const documentValues = collectDocumentValues(raw);
  const studentIds = uniqueTexts(filterSensitiveAliases([
    canonicalId,
    declaredStudentId,
    raw.studentKey,
    raw.estudianteId,
    legacyStudentKey,
    raw.id,
    raw.contactId,
    sourceRow,
    sourceDocId,
    ...(Array.isArray(raw.studentIds) ? raw.studentIds : []),
    ...(Array.isArray(raw.students) ? raw.students : []),
  ], documentValues));

  const status = firstText(raw.estado, raw.status, raw.estadoActual);
  const processes = normalizeProcesses(raw, canonicalId, name);
  const firstProcess = processes[0] || {};

  return {
    studentId: canonicalId,
    studentKey: canonicalId,
    id: canonicalId,
    idConflict,
    declaredStudentId,
    legacyPrimaryId,
    studentIds,
    documentValues, // solo para filtrar; jamás se escribe en destinos
    identityHold: raw.identityHold === true,
    legacyStudentKey,
    contactId: toText(raw.contactId),
    sourceDocId,
    sourceRow: sourceRow || null,
    nombre: name,
    name,
    normalizedName: normalizeText(name),
    estado: status,
    status,
    active: isAllowedStudentStatus(status),
    email: emails[0] || "",
    emails,
    edad: raw.edad ?? raw.age ?? null,
    interesesMusicales: firstText(raw.interesesMusicales, raw.intereses, raw.interests),
    intereses: firstText(raw.intereses, raw.interesesMusicales, raw.interests),
    area: firstText(raw.area, raw.arte, raw.course, raw.curso, firstProcess.area, firstProcess.arte),
    programa: firstText(raw.programa, raw.curso, raw.course, firstProcess.label),
    instrumento: firstText(raw.instrumento, raw.instrument, raw.detalle, firstProcess.instrumento, firstProcess.detalle),
    modalidad: firstText(raw.modalidad, raw.modality),
    sede: firstText(raw.sede),
    docente: firstText(raw.docente, raw.teacher, firstProcess.docente),
    teacher: firstText(raw.teacher, raw.docente, firstProcess.teacher),
    acudiente: firstText(raw.acudiente, raw.responsable, raw.guardianName, raw.nombre_completo_acudiente),
    processes,
    source: SOURCE_PROJECT_ID,
    identitySource: SOURCE_PROJECT_ID,
    syncOrigin: "cloud_function",
    schemaVersion: SCHEMA_VERSION,
  };
}

// Compara únicamente la identidad que consumen RIP y Bitácoras. Los valores
// sensibles se usan solo en memoria y el resultado es una huella técnica que
// nunca se persiste ni se registra. Así, las escrituras internas de la huella
// documental, updatedAt u otros metadatos no provocan una segunda réplica.
function canonicalizeForHash(value) {
  if (value instanceof Set) {
    return Array.from(value).sort().map(canonicalizeForHash);
  }
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalizeForHash(value[key]);
      return result;
    }, {});
  }
  return value;
}

function identityRelevantFingerprint(raw, sourceDocId) {
  const normalized = normalizeStudent(raw || {}, sourceDocId);
  const projection = normalized
    ? {
        ...normalized,
        documentValues: Array.from(normalized.documentValues || []).sort(),
        normalizedDocument: normalizeDocumentForFingerprint(raw || {}),
      }
    : { missingIdentity: true };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalizeForHash(projection)))
    .digest("hex");
}

function identityChangeDecision({ beforeExists, afterExists, before, after, sourceDocId }) {
  if (!afterExists) return { shouldSync: false, reason: "deleted" };
  if (!beforeExists) return { shouldSync: true, reason: "created" };
  const beforeFingerprint = identityRelevantFingerprint(before || {}, sourceDocId);
  const afterFingerprint = identityRelevantFingerprint(after || {}, sourceDocId);
  return beforeFingerprint === afterFingerprint
    ? { shouldSync: false, reason: "internal_metadata_only" }
    : { shouldSync: true, reason: "identity_changed" };
}

function maskTechnicalId(value) {
  const text = toText(value);
  if (!text) return "";
  if (text.length <= 8 || text.includes("@") || /\.[a-z]{2,}$/i.test(text)) {
    return `sid#${crypto.createHash("sha256").update(text).digest("hex").slice(0, 8)}`;
  }
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function safeTechnicalCode(error, fallback = "SYNC_ERROR") {
  const candidate = toText(error && (error.code || error.name));
  if (
    candidate &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(candidate) &&
    !/(email|name|document|phone|address|health)/i.test(candidate)
  ) {
    return candidate;
  }
  return fallback;
}

const SAFE_TECHNICAL_OPERATIONS = new Set([
  "bitacoras_legacy_alias",
  "bitacoras_student",
  "bitacoras_user",
  "bitacoras_users",
  "document_index",
  "identity_guard",
  "identity_resolution",
  "identity_sync",
  "legacy_side_effects",
  "rip_failed",
  "rip_skipped",
  "rip_student",
  "sync_log",
]);
const SAFE_TECHNICAL_COUNT_KEYS = new Set([
  "conflicts",
  "idConflicts",
  "recipients",
  "writes",
]);

function buildTechnicalLog({ eventId, runId, studentId, status, durationMs, operations, code, counts }) {
  const safeCounts = {};
  for (const [key, value] of Object.entries(counts || {})) {
    if (
      SAFE_TECHNICAL_COUNT_KEYS.has(key) &&
      (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
    ) {
      safeCounts[key] = value;
    }
  }
  return {
    eventId: toText(eventId).slice(0, 120),
    ...(runId ? { runId: toText(runId).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) } : {}),
    studentId: maskTechnicalId(studentId),
    status: toText(status).replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 60),
    durationMs: Math.max(0, Number(durationMs) || 0),
    operations: uniqueTexts(operations || []).filter((operation) => SAFE_TECHNICAL_OPERATIONS.has(operation)),
    ...(code ? { code: safeTechnicalCode({ code }, "SYNC_CODE") } : {}),
    ...(Object.keys(safeCounts).length ? { counts: safeCounts } : {}),
  };
}

function userDocId(email) {
  return toText(email).replace(/\s+/g, "").toLowerCase();
}

function processIdentity(process) {
  if (!process || typeof process !== "object") return "";
  const area = normalizeText(process.arte || process.area);
  const detail = normalizeText(process.detalle || process.instrumento);
  if (!area && !detail) return "";
  return `${area}|${detail}`;
}

// Las áreas agregadas a mano desde Bitácoras no existen en el proyecto origen;
// si el sync reescribe `processes` completo, las borra. Se conservan las
// existentes que el origen no conoce (quitarlas se hace desde el perfil).
function mergeProcesses(existingProcesses, syncedProcesses) {
  const synced = Array.isArray(syncedProcesses) ? syncedProcesses : [];
  const existing = Array.isArray(existingProcesses) ? existingProcesses : [];
  const syncedIdentities = new Set(synced.map(processIdentity).filter(Boolean));
  const kept = existing.filter((process) => {
    const identity = processIdentity(process);
    return identity && !syncedIdentities.has(identity);
  });
  return [...synced, ...kept];
}

function ripOwnsStatus(existingDoc) {
  const rip = existingDoc && typeof existingDoc.rip === "object" ? existingDoc.rip : null;
  return Boolean(rip && (rip.statusVersion || rip.statusCode || rip.statusLabel));
}

/* =========================
   Escrituras: Bitácoras
========================= */

function resolvePedagogicalProfileFields(normalized = {}, existing = {}) {
  // Modalidad e intereses también se editan directamente en Bitácoras. Si la
  // fuente de identidad no los trae, no debemos borrar una actualización
  // pedagógica que ya confirmó una docente en este proyecto.
  return {
    modalidad: firstText(
      normalized.modalidad,
      normalized.modality,
      existing.modalidad,
      existing.modality
    ),
    interesesMusicales: firstText(
      normalized.interesesMusicales,
      normalized.intereses,
      existing.interesesMusicales,
      existing.intereses
    ),
  };
}

async function mergeBitacorasStudent(normalized) {
  const ref = bitacorasDb.collection(TARGET_STUDENTS_COLLECTION).doc(normalized.studentId);
  const snap = await ref.get();
  const existing = snap.exists ? snap.data() || {} : {};
  const { modalidad, interesesMusicales } = resolvePedagogicalProfileFields(
    normalized,
    existing
  );
  const existingIds = Array.isArray(existing.studentIds) ? existing.studentIds : [];
  // Los IDs previos pueden traer el documento (syncs antiguos): se filtra
  // SIEMPRE al reescribir. sanitize-sensitive-aliases.js limpia el resto.
  const mergedStudentIds = uniqueTexts(filterSensitiveAliases([
    ...existingIds,
    existing.studentId,
    existing.studentKey,
    ...normalized.studentIds,
  ], normalized.documentValues));

  const payload = {
    // Identidad (propiedad de Lista) — campos planos de compatibilidad.
    studentId: normalized.studentId,
    studentKey: normalized.studentKey,
    id: normalized.id,
    studentIds: mergedStudentIds,
    legacyStudentKey: normalized.legacyStudentKey,
    contactId: normalized.contactId,
    sourceDocId: normalized.sourceDocId,
    sourceRow: normalized.sourceRow,
    nombre: normalized.nombre,
    name: normalized.name,
    normalizedName: normalized.normalizedName,
    email: normalized.email,
    correo: normalized.email,
    correoElectronico: normalized.email,
    emails: normalized.emails,
    edad: normalized.edad,
    interesesMusicales,
    intereses: interesesMusicales,
    area: normalized.area,
    programa: normalized.programa,
    instrumento: normalized.instrumento,
    modalidad,
    modality: modalidad,
    sede: normalized.sede,
    docente: normalized.docente,
    teacher: normalized.teacher,
    acudiente: normalized.acudiente,
    processes: mergeProcesses(existing.processes, normalized.processes),
    source: normalized.source,
    syncOrigin: normalized.syncOrigin,
    schemaVersion: SCHEMA_VERSION,

    // Identidad como mapa anidado: los sync posteriores (RIP) solo tocan `rip`.
    identity: {
      name: normalized.name,
      normalizedName: normalized.normalizedName,
      emails: normalized.emails,
      contactId: normalized.contactId,
      source: SOURCE_PROJECT_ID,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },

    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: snap.exists
      ? existing.createdAt || admin.firestore.FieldValue.serverTimestamp()
      : admin.firestore.FieldValue.serverTimestamp(),
  };

  if (normalized.idConflict) {
    payload.identityConflict = {
      declaredStudentId: normalized.declaredStudentId,
      canonicalId: normalized.studentId,
      source: "syncStudentIdentity",
    };
  }

  // Estado: solo mientras RIP no haya publicado (rip.statusVersion ausente).
  // Nunca se toca el mapa `rip` desde este sync.
  if (!ripOwnsStatus(existing)) {
    payload.estado = normalized.estado;
    payload.status = normalized.status;
    payload.active = normalized.active;
  }

  await ref.set(payload, { merge: true });
  return mergedStudentIds;
}

// Marca el doc espejo con el ID antiguo (si difiere del canónico) como alias
// y absorbe sus datos en el doc canónico. No borra nada.
async function absorbLegacyBitacorasDoc(normalized) {
  const legacyId = toText(normalized.legacyPrimaryId);
  if (!legacyId || legacyId === normalized.studentId) return null;

  const legacyRef = bitacorasDb.collection(TARGET_STUDENTS_COLLECTION).doc(legacyId);
  const legacySnap = await legacyRef.get();
  if (!legacySnap.exists) return null;

  const legacy = legacySnap.data() || {};
  if (toText(legacy.legacyAliasOf) === normalized.studentId) {
    return { legacyId, alreadyAliased: true };
  }

  const canonicalRef = bitacorasDb.collection(TARGET_STUDENTS_COLLECTION).doc(normalized.studentId);
  const canonicalSnap = await canonicalRef.get();
  const canonical = canonicalSnap.exists ? canonicalSnap.data() || {} : {};

  await canonicalRef.set(
    {
      studentIds: uniqueTexts(filterSensitiveAliases([
        ...(Array.isArray(canonical.studentIds) ? canonical.studentIds : []),
        ...(Array.isArray(legacy.studentIds) ? legacy.studentIds : []),
        legacy.studentId,
        legacy.studentKey,
        legacyId,
      ], normalized.documentValues)),
      processes: mergeProcesses(legacy.processes, canonical.processes),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await legacyRef.set(
    {
      legacyAliasOf: normalized.studentId,
      legacyAliasAt: admin.firestore.FieldValue.serverTimestamp(),
      legacyAliasSource: "syncStudentIdentity",
    },
    { merge: true }
  );

  return { legacyId, alreadyAliased: false };
}

async function upsertAccessUsers(normalized, mergedStudentIds) {
  const emails = normalized.emails || [];

  await Promise.all(emails.map(async (email) => {
    const id = userDocId(email);
    if (!id) return;

    const ref = bitacorasDb.collection(TARGET_USERS_COLLECTION).doc(id);
    const snap = await ref.get();
    const existing = snap.exists ? snap.data() || {} : {};
    const existingIds = Array.isArray(existing.studentIds) ? existing.studentIds : [];
    const nextStudentIds = uniqueTexts(filterSensitiveAliases([
      ...existingIds,
      existing.studentId,
      existing.studentKey,
      ...mergedStudentIds,
    ], normalized.documentValues));

    const existingRole = normalizeText(existing.role || existing.rol);
    if (existingRole && !["student", "estudiante", "acudiente", "guardian", "parent"].includes(existingRole)) {
      logger.warn("Usuario omitido por rol no estudiantil.", buildTechnicalLog({
        studentId: normalized.studentId,
        status: "skipped",
        operations: ["bitacoras_user"],
        code: "ROLE_CONFLICT",
        counts: { conflicts: 1 },
      }));
      return;
    }

    const payload = {
      email: id,
      role: "student",
      studentId: normalized.studentId,
      studentKey: normalized.studentKey,
      studentIds: nextStudentIds,
      displayName: normalized.nombre,
      source: SOURCE_PROJECT_ID,
      syncOrigin: "cloud_function",
      sourceDocId: normalized.sourceDocId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: snap.exists
        ? existing.createdAt || admin.firestore.FieldValue.serverTimestamp()
        : admin.firestore.FieldValue.serverTimestamp(),
    };

    // `active` y `studentStatus` pasan a ser propiedad de RIP cuando su sync
    // ya marcó este usuario. Antes de eso, Lista conserva el comportamiento
    // previo para no dejar a nadie sin acceso durante la transición.
    if (toText(existing.statusSource) !== RIP_PROJECT_ID) {
      payload.studentStatus = normalized.estado;
      payload.active = isAllowedStudentStatus(normalized.estado);
    }

    await ref.set(payload, { merge: true });
  }));
}

/* =========================
   Escrituras: RIP (directorio local de identidades)
========================= */

async function mirrorIdentityToRip(normalized) {
  if (!ripTargetEnabled()) return { skipped: true, reason: "RIP_TARGET_DISABLED" };

  const ref = ripDb.collection(TARGET_STUDENTS_COLLECTION).doc(normalized.studentId);
  const snap = await ref.get();
  const existing = snap.exists ? snap.data() || {} : {};

  await ref.set(
    {
      studentId: normalized.studentId,
      officialStudentId: normalized.studentId,
      name: normalized.name,
      estudiante: normalized.name,
      nameKey: normalized.normalizedName,
      estudianteKey: normalized.normalizedName,
      normalizedName: normalized.normalizedName,
      emails: normalized.emails,
      email: normalized.email,
      contactId: normalized.contactId,
      aliases: uniqueTexts(filterSensitiveAliases([
        ...(Array.isArray(existing.aliases) ? existing.aliases : []),
        ...normalized.studentIds,
      ], normalized.documentValues)),
      identitySource: SOURCE_PROJECT_ID,
      syncOrigin: "cloud_function",
      schemaVersion: SCHEMA_VERSION,
      identityUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: snap.exists
        ? existing.createdAt || admin.firestore.FieldValue.serverTimestamp()
        : admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // Si RIP ya tiene un doc legado por nombre normalizado, se le anota el
  // officialStudentId para que el resolutor de identidad pueda mapearlo.
  // Solo se actualiza si ya existe: no se crean stubs por nombre.
  const nameKey = normalized.normalizedName;
  if (nameKey && nameKey !== normalized.studentId) {
    const legacyRef = ripDb.collection(TARGET_STUDENTS_COLLECTION).doc(nameKey);
    const legacySnap = await legacyRef.get();
    if (legacySnap.exists) {
      const legacy = legacySnap.data() || {};
      if (toText(legacy.officialStudentId) !== normalized.studentId) {
        await legacyRef.set(
          {
            officialStudentId: normalized.studentId,
            officialStudentIdSource: "syncStudentIdentity",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
    }
  }

  return { skipped: false };
}

/* =========================
   Logs y estado del sync
========================= */

async function writeSyncStatus(payload) {
  await bitacorasDb.collection(SYNC_META_COLLECTION).doc(SYNC_META_DOC).set(
    {
      ...payload,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

// Solo errores y procesos administrativos generan documento de log propio.
async function logSyncError(event, error, context = {}) {
  try {
    await bitacorasDb.collection(SYNC_LOGS_COLLECTION).add({
      event,
      ok: false,
      errorCode: safeTechnicalCode(error),
      studentId: maskTechnicalId(context.sourceDocId || context.studentId),
      source: SOURCE_PROJECT_ID,
      schemaVersion: SCHEMA_VERSION,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (logError) {
    logger.error("No se pudo escribir sync_logs.", buildTechnicalLog({
      status: "failed",
      operations: ["sync_log"],
      code: safeTechnicalCode(logError, "SYNC_LOG_WRITE_FAILED"),
    }));
  }
}

/* =========================
   Huella privada del documento e índice de duplicados

   - HMAC-SHA256(documentoNormalizado, DOC_INDEX_SECRET) calculado SOLO en
     backend; ni el documento ni la huella salen de estudiantes-musicala.
   - student_document_index/{fingerprint} se mantiene por transacción.
   - Si la huella ya apunta a OTRO estudiante: el nuevo doc queda con
     identityHold=true + possibleDuplicateOf y NO se sincroniza hasta que
     administración lo resuelva (quitar identityHold desde la Lista).
========================= */

function readDocSecret() {
  try {
    return toText(DOC_INDEX_SECRET.value());
  } catch (_error) {
    // Secreto no vinculado todavía (entorno sin Secret Manager): se omite
    // la huella y queda registrado; el resto del sync continúa.
    return "";
  }
}

/*
  Decisión pura sobre la huella (testeable sin Firestore):
  - "skip_definitive": SOLO cuando documentFingerprint existe Y
    fingerprintVersion === 2 (la huella HMAC oficial).
  - "no_document": el doc no trae número de documento normalizable.
  - "compute": hay documento sin huella v2. Incluye el caso de un SHA
    antiguo guardado en documentFingerprint SIN fingerprintVersion === 2
    (p. ej. por una versión previa de la migración): se recalcula la huella
    HMAC, se crea el índice privado y se REEMPLAZA la antigua.
  Un documentShaLegacy nunca cuenta como huella definitiva.
*/
function fingerprintDecision(raw) {
  const data = raw || {};
  if (toText(data.documentFingerprint) && data.fingerprintVersion === 2) {
    return "skip_definitive";
  }
  if (!normalizeDocumentForFingerprint(data)) return "no_document";
  return "compute";
}

async function ensureDocumentFingerprint(raw, sourceDocId) {
  const decision = fingerprintDecision(raw);
  if (decision === "skip_definitive") {
    return { hold: raw.identityHold === true, computed: false };
  }
  if (decision === "no_document") {
    return { hold: raw.identityHold === true, computed: false, reason: "no_document" };
  }

  const normalizedDocument = normalizeDocumentForFingerprint(raw || {});

  const secretValue = readDocSecret();
  if (!secretValue) {
    logger.warn("Huella documental pendiente.", buildTechnicalLog({
      studentId: sourceDocId,
      status: "skipped",
      operations: ["document_index"],
      code: "DOC_INDEX_SECRET_UNAVAILABLE",
    }));
    return { hold: raw.identityHold === true, computed: false, reason: "no_secret" };
  }

  const fingerprint = buildDocumentFingerprint(normalizedDocument, secretValue);
  let duplicateOf = "";

  await sourceDb.runTransaction(async (tx) => {
    const indexRef = sourceDb.collection(DOCUMENT_INDEX_COLLECTION).doc(fingerprint);
    const indexSnap = await tx.get(indexRef);
    const owner = indexSnap.exists ? toText((indexSnap.data() || {}).studentId) : "";

    if (owner && owner !== sourceDocId) {
      duplicateOf = owner;
      tx.set(indexRef, {
        duplicates: admin.firestore.FieldValue.arrayUnion(sourceDocId),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } else {
      tx.set(indexRef, {
        studentId: sourceDocId,
        createdAt: indexSnap.exists
          ? (indexSnap.data() || {}).createdAt || admin.firestore.FieldValue.serverTimestamp()
          : admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    const studentRef = sourceDb.collection(SOURCE_STUDENTS_COLLECTION).doc(sourceDocId);
    tx.set(studentRef, {
      documentFingerprint: fingerprint, // permanece SOLO en estudiantes-musicala
      fingerprintVersion: 2,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(duplicateOf ? {
        identityHold: true,
        identityHoldReason: "possible_duplicate_document",
        possibleDuplicateOf: duplicateOf,
        identityHoldAt: admin.firestore.FieldValue.serverTimestamp(),
      } : {}),
    }, { merge: true });
  });

  return { hold: Boolean(duplicateOf), computed: true, duplicateOf };
}

/* =========================
   Orquestación por estudiante
========================= */

async function mirrorStudentDoc(raw, sourceDocId) {
  const normalized = normalizeStudent(raw || {}, sourceDocId);
  if (!normalized) {
    logger.warn("Identidad omitida por datos mínimos faltantes.", buildTechnicalLog({
      studentId: sourceDocId,
      status: "skipped",
      operations: [],
      code: "MISSING_IDENTITY",
    }));
    return {
      skipped: true,
      status: "missing_identity",
      studentId: maskTechnicalId(sourceDocId),
      idConflict: false,
      operations: [],
    };
  }

  // Huella + detección de duplicado por documento (backend, privado).
  let fingerprintResult = { hold: normalized.identityHold };
  try {
    fingerprintResult = await ensureDocumentFingerprint(raw || {}, sourceDocId);
  } catch (error) {
    // Nunca se registra el documento ni la huella en el error.
    logger.error("Fallo calculando huella de documento.", buildTechnicalLog({
      studentId: sourceDocId,
      status: "failed",
      operations: ["document_index"],
      code: safeTechnicalCode(error, "FINGERPRINT_FAILED"),
    }));
    await logSyncError("ensureDocumentFingerprint", error, { sourceDocId });
  }

  // Duplicado posible confirmado o retención manual: NO se sincroniza hasta
  // que administración resuelva (retirar identityHold en la Lista).
  if (fingerprintResult.hold || normalized.identityHold) {
    logger.warn("Identidad en retención; no se sincroniza.", buildTechnicalLog({
      studentId: sourceDocId,
      status: "skipped",
      operations: ["document_index"],
      code: "IDENTITY_HOLD",
    }));
    await logSyncError(
      "identity_hold",
      { code: "IDENTITY_HOLD" },
      { sourceDocId }
    );
    return {
      skipped: true,
      status: "identity_hold",
      studentId: maskTechnicalId(sourceDocId),
      idConflict: normalized.idConflict,
      operations: ["document_index"],
    };
  }

  if (normalized.idConflict) {
    logger.warn("Conflicto de identificador resuelto con ID canónico.", buildTechnicalLog({
      studentId: sourceDocId,
      status: "continued",
      operations: ["identity_resolution"],
      code: "DECLARED_ID_CONFLICT",
      counts: { conflicts: 1 },
    }));
  }

  const result = {
    skipped: false,
    status: "completed",
    studentId: maskTechnicalId(normalized.studentId),
    idConflict: normalized.idConflict,
    operations: ["document_index"],
    counts: { recipients: normalized.emails.length },
  };

  const mergedStudentIds = await mergeBitacorasStudent(normalized);
  result.operations.push("bitacoras_student");
  const legacyAlias = await absorbLegacyBitacorasDoc(normalized);
  if (legacyAlias) result.operations.push("bitacoras_legacy_alias");
  await upsertAccessUsers(normalized, mergedStudentIds);
  result.operations.push("bitacoras_users");

  try {
    const ripResult = await mirrorIdentityToRip(normalized);
    result.operations.push(ripResult.skipped ? "rip_skipped" : "rip_student");
  } catch (error) {
    // Un fallo hacia RIP no debe tumbar el espejo hacia Bitácoras.
    result.status = "partial";
    result.operations.push("rip_failed");
    logger.error("Fallo publicando identidad hacia rip-musicala.", buildTechnicalLog({
      studentId: sourceDocId,
      status: "partial",
      operations: ["rip_student"],
      code: safeTechnicalCode(error, "RIP_WRITE_FAILED"),
    }));
    await logSyncError("mirrorIdentityToRip", error, {
      sourceDocId,
    });
  }

  return result;
}

/* =========================
   Backfill seguro y dirigido

   Esta ruta es deliberadamente independiente del trigger normal:
   - nunca enumera estudiantes por orden global;
   - dryRun solo lee y calcula;
   - apply escribe exclusivamente parches mínimos de identidad;
   - no escribe estado, acceso, timestamps generales, app_config ni logs
     persistentes.
========================= */

const BACKFILL_MAX_STUDENTS = 10;
const BACKFILL_APPLY_CONFIRMATION = "APPLY_EXPLICIT_STUDENT_IDS";
const BACKFILL_APPLY_ENABLED = process.env.BACKFILL_APPLY_ENABLED === "true";
const BACKFILL_PILOT_ID = "msQWTSLw0PZwR6JtZOBz";
const BACKFILL_CREATED_CUTOFF_MS = Date.parse("2026-07-12T05:00:00.000Z");
const BACKFILL_PLAN_VERSION = 2;
const BACKFILL_OPERATION = "backfill";
const USER_REPAIR_OPERATION = "repairUsers";

class BackfillRequestError extends Error {
  constructor(code, httpStatus = 400) {
    super(code);
    this.name = "BackfillRequestError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function validBackfillStudentId(value) {
  const id = toText(value);
  if (!id || id !== value || id.includes("/") || /[\u0000-\u001f\u007f]/.test(id)) return false;
  return Buffer.byteLength(id, "utf8") <= 1500;
}

function validateBackfillRequestBody(body, query = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BackfillRequestError("INVALID_BODY");
  }
  if (Object.keys(query || {}).length) {
    throw new BackfillRequestError("QUERY_PARAMETERS_NOT_ALLOWED");
  }

  const mode = toText(body.mode || "dryRun");
  if (!["dryRun", "apply"].includes(mode)) {
    throw new BackfillRequestError("INVALID_MODE");
  }
  const runId = toText(body.runId);
  if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(runId)) {
    throw new BackfillRequestError("INVALID_RUN_ID");
  }
  if (!Array.isArray(body.studentIds) || body.studentIds.length < 1) {
    throw new BackfillRequestError("STUDENT_IDS_REQUIRED");
  }
  if (body.studentIds.length > BACKFILL_MAX_STUDENTS) {
    throw new BackfillRequestError("TOO_MANY_STUDENT_IDS");
  }
  if (!body.studentIds.every(validBackfillStudentId)) {
    throw new BackfillRequestError("INVALID_STUDENT_ID");
  }
  const studentIds = body.studentIds.map(toText);
  if (new Set(studentIds).size !== studentIds.length) {
    throw new BackfillRequestError("DUPLICATE_STUDENT_IDS");
  }

  const operation = toText(body.operation || BACKFILL_OPERATION);
  if (![BACKFILL_OPERATION, USER_REPAIR_OPERATION].includes(operation)) {
    throw new BackfillRequestError("INVALID_OPERATION");
  }
  let repairs = [];
  if (operation === USER_REPAIR_OPERATION) {
    if (!Array.isArray(body.repairs) || body.repairs.length !== studentIds.length) {
      throw new BackfillRequestError("USER_REPAIRS_REQUIRED");
    }
    const repairIds = new Set();
    repairs = body.repairs.map((repair) => {
      if (!repair || typeof repair !== "object" || Array.isArray(repair)) {
        throw new BackfillRequestError("INVALID_USER_REPAIR");
      }
      const studentId = toText(repair.studentId);
      if (!studentIds.includes(studentId) || repairIds.has(studentId)) {
        throw new BackfillRequestError("INVALID_USER_REPAIR_STUDENT");
      }
      repairIds.add(studentId);
      if (!Array.isArray(repair.users) || repair.users.length < 1 || repair.users.length > 10) {
        throw new BackfillRequestError("INVALID_USER_REPAIR_USERS");
      }
      const emailIndexes = new Set();
      const users = repair.users.map((user) => {
        const emailIndex = user && user.emailIndex;
        const restoreUpdatedAt = toText(user && user.restoreUpdatedAt);
        if (!Number.isInteger(emailIndex) || emailIndex < 0 || emailIndex > 19 || emailIndexes.has(emailIndex)) {
          throw new BackfillRequestError("INVALID_USER_REPAIR_EMAIL_INDEX");
        }
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(restoreUpdatedAt) ||
            Number.isNaN(Date.parse(restoreUpdatedAt))) {
          throw new BackfillRequestError("INVALID_USER_REPAIR_TIMESTAMP");
        }
        emailIndexes.add(emailIndex);
        return { emailIndex, restoreUpdatedAt };
      });
      return { studentId, users };
    });
  } else if (body.repairs !== undefined) {
    throw new BackfillRequestError("UNEXPECTED_USER_REPAIRS");
  }

  if (mode === "apply") {
    if (!BACKFILL_APPLY_ENABLED) {
      throw new BackfillRequestError("APPLY_DISABLED");
    }
    if (body.confirmApply !== BACKFILL_APPLY_CONFIRMATION) {
      throw new BackfillRequestError("APPLY_CONFIRMATION_REQUIRED");
    }
    if (!/^[a-f0-9]{64}$/.test(toText(body.planHash))) {
      throw new BackfillRequestError("PLAN_HASH_REQUIRED");
    }
    if (!/^[a-f0-9]{64}$/.test(toText(body.snapshotHash))) {
      throw new BackfillRequestError("SNAPSHOT_HASH_REQUIRED");
    }
  }

  return {
    mode,
    operation,
    runId,
    studentIds,
    repairs,
    planHash: toText(body.planHash),
    snapshotHash: toText(body.snapshotHash),
  };
}

function backfillCanonicalValue(value) {
  if (Array.isArray(value)) {
    const normalized = value.map(backfillCanonicalValue);
    return normalized.every((item) => ["string", "number", "boolean"].includes(typeof item))
      ? normalized.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : normalized;
  }
  if (value && typeof value.toDate === "function") return value.toDate().toISOString();
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = backfillCanonicalValue(value[key]);
      return result;
    }, {});
  }
  return value === undefined ? null : value;
}

function backfillValuesEqual(left, right) {
  return JSON.stringify(backfillCanonicalValue(left)) === JSON.stringify(backfillCanonicalValue(right));
}

function backfillValueContains(existing, proposed) {
  if (proposed && typeof proposed === "object" && !Array.isArray(proposed)) {
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) return false;
    return Object.entries(proposed).every(([key, value]) =>
      Object.prototype.hasOwnProperty.call(existing, key) && backfillValueContains(existing[key], value)
    );
  }
  return backfillValuesEqual(existing, proposed);
}

function backfillPatchDiff(existing, patch) {
  const added = [];
  const changed = [];
  const unchanged = [];
  for (const [field, value] of Object.entries(patch || {})) {
    if (!Object.prototype.hasOwnProperty.call(existing || {}, field)) added.push(field);
    else if (backfillValueContains(existing[field], value)) unchanged.push(field);
    else changed.push(field);
  }
  return { added, changed, unchanged, material: added.length > 0 || changed.length > 0 };
}

function technicalVersion(snapshot) {
  if (!snapshot || !snapshot.exists) return "missing";
  return snapshot.updateTime && typeof snapshot.updateTime.toDate === "function"
    ? snapshot.updateTime.toDate().toISOString()
    : "exists";
}

function makeBackfillWrite({ project, collection, docId, snapshot, patch, destination }) {
  const existing = snapshot && snapshot.exists ? snapshot.data() || {} : {};
  const diff = backfillPatchDiff(existing, patch);
  return {
    project,
    collection,
    docId,
    destination,
    existedBefore: Boolean(snapshot && snapshot.exists),
    version: technicalVersion(snapshot),
    patch,
    diff,
  };
}

function safeBackfillErrorCode(error) {
  if (error instanceof BackfillRequestError) return error.code;
  const candidate = toText(error && error.code).toLowerCase();
  const knownCodes = new Set([
    "aborted", "already-exists", "deadline-exceeded", "failed-precondition",
    "not-found", "permission-denied", "resource-exhausted", "unavailable",
  ]);
  return knownCodes.has(candidate)
    ? `BACKFILL_${candidate.replace(/-/g, "_").toUpperCase()}`
    : "BACKFILL_INTERNAL_ERROR";
}

function buildBackfillPlanHash(plan) {
  const hashMaterial = {
    version: BACKFILL_PLAN_VERSION,
    operation: plan.operation || BACKFILL_OPERATION,
    runId: plan.runId,
    requestedStudentIds: plan.requestedStudentIds,
    eligibilityContextVersion: plan.eligibilityContextVersion,
    students: plan.students.map((student) => ({
      sourceDocId: student.sourceDocId,
      sourceVersion: student.sourceVersion,
      eligible: student.eligible,
      action: student.action,
      codes: student.codes,
      writes: student.writes.map((write) => ({
        project: write.project,
        collection: write.collection,
        docId: write.docId,
        version: write.version,
        patch: write.patch,
        repairEvidence: write.repairEvidence || null,
        material: write.diff.material,
      })),
      reads: student.reads,
    })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(backfillCanonicalValue(hashMaterial))).digest("hex");
}

function publicBackfillStudentPlan(student) {
  const materialWrites = student.writes.filter((write) => write.diff.material);
  const added = uniqueTexts(materialWrites.flatMap((write) => write.diff.added));
  const changed = uniqueTexts(materialWrites.flatMap((write) => write.diff.changed));
  return {
    studentId: maskTechnicalId(student.sourceDocId),
    eligible: student.eligible,
    action: student.action,
    destinations: uniqueTexts(materialWrites.map((write) => write.destination)),
    fields: {
      added,
      changed,
      preserved: [
        "academic_fields", "access_fields", "active", "historical_logs", "payments",
        "permissions", "programming", "roles", "status", "statusSource", "studentStatus",
      ],
    },
    codes: student.codes,
    proposedWrites: materialWrites.length,
    versions: student.reads.map((read) => ({
      destination: read.destination,
      version: read.version,
    })),
  };
}

function publicBackfillPlan(plan) {
  const students = plan.students.map(publicBackfillStudentPlan);
  return {
    ok: true,
    mode: plan.mode,
    operation: plan.operation || BACKFILL_OPERATION,
    runId: plan.runId,
    planVersion: BACKFILL_PLAN_VERSION,
    planHash: plan.planHash,
    eligibilityContextVersion: plan.eligibilityContextVersion,
    requested: students.length,
    counts: {
      eligible: students.filter((item) => item.eligible).length,
      create: students.filter((item) => item.action === "create").length,
      merge: students.filter((item) => item.action === "merge").length,
      noOp: students.filter((item) => item.action === "no_op").length,
      conflict: students.filter((item) => item.action === "conflict").length,
      skipped: students.filter((item) => item.action === "skipped").length,
      proposedWrites: students.reduce((total, item) => total + item.proposedWrites, 0),
    },
    studentIds: students.map((item) => item.studentId),
    students,
  };
}

function sourceSnapshotVersion(entries) {
  return crypto.createHash("sha256").update(JSON.stringify(entries
    .map((entry) => [entry.id, entry.updateTime])
    .sort((a, b) => a[0].localeCompare(b[0])))).digest("hex");
}

function minimalBitacorasIdentityPatch(normalized, existing) {
  return {
    studentId: normalized.studentId,
    studentKey: normalized.studentId,
    studentIds: uniqueTexts(filterSensitiveAliases([
      ...(Array.isArray(existing && existing.studentIds) ? existing.studentIds : []),
      existing && existing.studentId,
      existing && existing.studentKey,
      ...normalized.studentIds,
    ], normalized.documentValues)),
    sourceDocId: normalized.sourceDocId,
    contactId: normalized.contactId,
    nombre: normalized.nombre,
    name: normalized.name,
    normalizedName: normalized.normalizedName,
    email: normalized.email,
    emails: normalized.emails,
    identity: {
      name: normalized.name,
      normalizedName: normalized.normalizedName,
      emails: normalized.emails,
      contactId: normalized.contactId,
      source: SOURCE_PROJECT_ID,
    },
    identitySource: SOURCE_PROJECT_ID,
    schemaVersion: SCHEMA_VERSION,
  };
}

function minimalRipIdentityPatch(normalized, existing) {
  return {
    studentId: normalized.studentId,
    officialStudentId: normalized.studentId,
    name: normalized.name,
    estudiante: normalized.name,
    nameKey: normalized.normalizedName,
    estudianteKey: normalized.normalizedName,
    normalizedName: normalized.normalizedName,
    emails: normalized.emails,
    email: normalized.email,
    contactId: normalized.contactId,
    aliases: uniqueTexts(filterSensitiveAliases([
      ...(Array.isArray(existing && existing.aliases) ? existing.aliases : []),
      ...normalized.studentIds,
    ], normalized.documentValues)),
    identitySource: SOURCE_PROJECT_ID,
    schemaVersion: SCHEMA_VERSION,
  };
}

function minimalUserIdentityPatch(normalized, existing, emailNormalized = normalized.email) {
  return {
    studentId: normalized.studentId,
    studentIds: uniqueTexts(filterSensitiveAliases([
      ...(Array.isArray(existing && existing.studentIds) ? existing.studentIds : []),
      existing && existing.studentId,
      existing && existing.studentKey,
      ...normalized.studentIds,
    ], normalized.documentValues)),
    emailNormalized,
  };
}

async function buildSafeBackfillPlan({ mode, runId, studentIds }) {
  const sourceSnapshot = await sourceDb.collection(SOURCE_STUDENTS_COLLECTION).get();
  const sourceEntries = sourceSnapshot.docs.map((doc) => ({
    id: doc.id,
    raw: doc.data() || {},
    snapshot: doc,
    createTime: doc.createTime && doc.createTime.toDate ? doc.createTime.toDate().getTime() : 0,
    updateTime: technicalVersion(doc),
  }));
  const byId = new Map(sourceEntries.map((entry) => [entry.id, entry]));
  const emailOwners = new Map();
  const documentOwners = new Map();
  for (const entry of sourceEntries) {
    for (const email of extractEmails(
      entry.raw.email, entry.raw.correo, entry.raw.correoElectronico, entry.raw.mail,
      entry.raw.studentEmail, entry.raw.emailEstudiante, entry.raw.correoEstudiante,
      entry.raw.emailAcudiente, entry.raw.correoAcudiente, entry.raw.acudienteEmail,
      entry.raw.correo_electronico_envio_de_guias_e_informacion_adicional,
      entry.raw.emails, entry.raw.correos
    )) {
      if (!emailOwners.has(email)) emailOwners.set(email, []);
      emailOwners.get(email).push(entry.id);
    }
    const documentKey = normalizeDocumentForFingerprint(entry.raw);
    if (documentKey) {
      if (!documentOwners.has(documentKey)) documentOwners.set(documentKey, []);
      documentOwners.get(documentKey).push(entry.id);
    }
  }

  const secret = readDocSecret();
  const students = [];
  for (const sourceDocId of studentIds) {
    const entry = byId.get(sourceDocId);
    const student = {
      sourceDocId,
      sourceVersion: entry ? entry.updateTime : "missing",
      eligible: false,
      action: "skipped",
      codes: [],
      writes: [],
      reads: [{ destination: "source_student", version: entry ? entry.updateTime : "missing" }],
    };
    if (!entry) {
      student.codes.push("STUDENT_NOT_FOUND");
      students.push(student);
      continue;
    }
    if (sourceDocId === BACKFILL_PILOT_ID) student.codes.push("PILOT_EXCLUDED");
    if (entry.createTime >= BACKFILL_CREATED_CUTOFF_MS) student.codes.push("CREATED_AFTER_CUTOFF");
    if (entry.raw.identityHold === true) student.codes.push("IDENTITY_HOLD");

    const normalized = normalizeStudent(entry.raw, sourceDocId);
    if (!normalized) student.codes.push("MISSING_IDENTITY");
    if (normalized && normalized.idConflict) student.codes.push("DECLARED_ID_CONFLICT");
    if (normalized) {
      const duplicatedEmail = normalized.emails.some((email) => (emailOwners.get(email) || []).length > 1);
      if (duplicatedEmail) student.codes.push("DUPLICATE_EMAIL");
      const documentKey = normalizeDocumentForFingerprint(entry.raw);
      if (documentKey && (documentOwners.get(documentKey) || []).length > 1) {
        student.codes.push("DUPLICATE_DOCUMENT");
      }
    }
    if (student.codes.length) {
      student.action = student.codes.some((code) => /CONFLICT|DUPLICATE|HOLD/.test(code)) ? "conflict" : "skipped";
      students.push(student);
      continue;
    }

    const normalizedDocument = normalizeDocumentForFingerprint(entry.raw);
    let fingerprint = entry.raw.fingerprintVersion === 2 ? toText(entry.raw.documentFingerprint) : "";
    if (!fingerprint && normalizedDocument) {
      if (!secret) {
        student.codes.push("DOC_INDEX_SECRET_UNAVAILABLE");
        student.action = "conflict";
        students.push(student);
        continue;
      }
      fingerprint = buildDocumentFingerprint(normalizedDocument, secret);
    }

    let indexSnap = null;
    if (fingerprint) {
      indexSnap = await sourceDb.collection(DOCUMENT_INDEX_COLLECTION).doc(fingerprint).get();
      student.reads.push({ destination: "document_index", version: technicalVersion(indexSnap) });
      const owner = indexSnap.exists ? toText((indexSnap.data() || {}).studentId) : "";
      if (owner && owner !== sourceDocId) {
        student.codes.push("HMAC_CONFLICT");
        student.action = "conflict";
        students.push(student);
        continue;
      }
    }

    const bitRef = bitacorasDb.collection(TARGET_STUDENTS_COLLECTION).doc(sourceDocId);
    const ripRef = ripDb.collection(TARGET_STUDENTS_COLLECTION).doc(sourceDocId);
    const [bitSnap, ripSnap] = await Promise.all([bitRef.get(), ripRef.get()]);
    student.reads.push(
      { destination: "bitacoras_student", version: technicalVersion(bitSnap) },
      { destination: "rip_student", version: technicalVersion(ripSnap) }
    );

    if (fingerprint) {
      student.writes.push(makeBackfillWrite({
        project: "source", collection: DOCUMENT_INDEX_COLLECTION, docId: fingerprint,
        snapshot: indexSnap, patch: { studentId: sourceDocId }, destination: "document_index",
      }));
      student.writes.push(makeBackfillWrite({
        project: "source", collection: SOURCE_STUDENTS_COLLECTION, docId: sourceDocId,
        snapshot: entry.snapshot, patch: { documentFingerprint: fingerprint, fingerprintVersion: 2 },
        destination: "source_student",
      }));
    }
    student.writes.push(makeBackfillWrite({
      project: "bitacoras", collection: TARGET_STUDENTS_COLLECTION, docId: sourceDocId,
      snapshot: bitSnap,
      patch: minimalBitacorasIdentityPatch(normalized, bitSnap.exists ? bitSnap.data() || {} : {}),
      destination: "bitacoras_student",
    }));
    student.writes.push(makeBackfillWrite({
      project: "rip", collection: TARGET_STUDENTS_COLLECTION, docId: sourceDocId,
      snapshot: ripSnap, patch: minimalRipIdentityPatch(normalized, ripSnap.exists ? ripSnap.data() || {} : {}),
      destination: "rip_student",
    }));

    for (let index = 0; index < normalized.emails.length; index += 1) {
      const email = normalized.emails[index];
      const userRef = bitacorasDb.collection(TARGET_USERS_COLLECTION).doc(userDocId(email));
      // eslint-disable-next-line no-await-in-loop
      const userSnap = await userRef.get();
      student.reads.push({ destination: `bitacoras_user_${index + 1}`, version: technicalVersion(userSnap) });
      student.writes.push(makeBackfillWrite({
        project: "bitacoras", collection: TARGET_USERS_COLLECTION, docId: userDocId(email),
        snapshot: userSnap,
        patch: minimalUserIdentityPatch(
          normalized,
          userSnap.exists ? userSnap.data() || {} : {},
          userDocId(email)
        ),
        destination: "bitacoras_user",
      }));
    }

    const legacyId = toText(normalized.legacyPrimaryId);
    if (legacyId && legacyId !== sourceDocId && !looksLikeDocumentNumber(legacyId)) {
      const legacyRef = bitacorasDb.collection(TARGET_STUDENTS_COLLECTION).doc(legacyId);
      // eslint-disable-next-line no-await-in-loop
      const legacySnap = await legacyRef.get();
      student.reads.push({ destination: "bitacoras_legacy_alias", version: technicalVersion(legacySnap) });
      if (legacySnap.exists) {
        student.writes.push(makeBackfillWrite({
          project: "bitacoras", collection: TARGET_STUDENTS_COLLECTION, docId: legacyId,
          snapshot: legacySnap,
          patch: { legacyAliasOf: sourceDocId, legacyAliasSource: "backfillStudentIdentity" },
          destination: "bitacoras_legacy_alias",
        }));
      }
    }

    student.eligible = true;
    const materialWrites = student.writes.filter((write) => write.diff.material);
    if (!materialWrites.length) student.action = "no_op";
    else if (materialWrites.some((write) => !write.existedBefore)) student.action = "create";
    else student.action = "merge";
    students.push(student);
  }

  const plan = {
    mode,
    operation: BACKFILL_OPERATION,
    runId,
    requestedStudentIds: studentIds,
    eligibilityContextVersion: sourceSnapshotVersion(sourceEntries),
    students,
  };
  plan.planHash = buildBackfillPlanHash(plan);
  return plan;
}

function firestoreTimestampFromRfc3339(value) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(toText(value));
  if (!match) throw new BackfillRequestError("INVALID_USER_REPAIR_TIMESTAMP");
  const seconds = Math.floor(Date.parse(`${match[1]}Z`) / 1000);
  const nanoseconds = Number((match[2] || "").padEnd(9, "0"));
  return new admin.firestore.Timestamp(seconds, nanoseconds);
}

function userRepairContextVersion(students) {
  const entries = students.flatMap((student) => student.reads.map((read) => [
    student.sourceDocId,
    read.destination,
    read.version,
  ]));
  return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

async function buildUserRepairPlan({ mode, runId, studentIds, repairs }) {
  const repairsByStudent = new Map(repairs.map((repair) => [repair.studentId, repair]));
  const students = [];
  for (const sourceDocId of studentIds) {
    // eslint-disable-next-line no-await-in-loop
    const sourceSnap = await sourceDb.collection(SOURCE_STUDENTS_COLLECTION).doc(sourceDocId).get();
    const student = {
      sourceDocId,
      sourceVersion: technicalVersion(sourceSnap),
      eligible: false,
      action: "skipped",
      codes: [],
      writes: [],
      reads: [{ destination: "source_student", version: technicalVersion(sourceSnap) }],
    };
    const normalized = sourceSnap.exists ? normalizeStudent(sourceSnap.data() || {}, sourceDocId) : null;
    if (!sourceSnap.exists) student.codes.push("STUDENT_NOT_FOUND");
    if (!normalized) student.codes.push("MISSING_IDENTITY");
    const repair = repairsByStudent.get(sourceDocId);
    if (!repair) student.codes.push("USER_REPAIR_SPEC_MISSING");

    if (normalized && repair) {
      for (const userRepair of repair.users) {
        const email = normalized.emails[userRepair.emailIndex];
        if (!email) {
          student.codes.push("USER_REPAIR_EMAIL_MISMATCH");
          continue;
        }
        const docId = userDocId(email);
        const userRef = bitacorasDb.collection(TARGET_USERS_COLLECTION).doc(docId);
        // eslint-disable-next-line no-await-in-loop
        const userSnap = await userRef.get();
        student.reads.push({ destination: "bitacoras_user", version: technicalVersion(userSnap) });
        if (!userSnap.exists) {
          student.codes.push("USER_REPAIR_DOCUMENT_MISSING");
          continue;
        }
        const existing = userSnap.data() || {};
        const role = normalizeText(existing.role || existing.rol);
        if (role && !["student", "estudiante", "acudiente", "guardian", "parent"].includes(role)) {
          student.codes.push("ROLE_CONFLICT");
          continue;
        }
        const canonicalOccurrences = (Array.isArray(existing.studentIds) ? existing.studentIds : [])
          .filter((id) => toText(id) === sourceDocId).length;
        if (canonicalOccurrences !== 1 || toText(existing.emailNormalized) !== docId) {
          student.codes.push("USER_IDENTITY_CONTEXT_MISMATCH");
          continue;
        }
        const patch = {
          studentId: sourceDocId,
          updatedAt: firestoreTimestampFromRfc3339(userRepair.restoreUpdatedAt),
        };
        const write = makeBackfillWrite({
          project: "bitacoras",
          collection: TARGET_USERS_COLLECTION,
          docId,
          snapshot: userSnap,
          patch,
          destination: "bitacoras_user_repair",
        });
        write.repairEvidence = { restoreUpdatedAt: userRepair.restoreUpdatedAt };
        student.writes.push(write);
      }
    }

    if (student.codes.length) {
      student.action = "conflict";
    } else {
      student.eligible = true;
      student.action = student.writes.some((write) => write.diff.material) ? "merge" : "no_op";
    }
    students.push(student);
  }
  const plan = {
    mode,
    operation: USER_REPAIR_OPERATION,
    runId,
    requestedStudentIds: studentIds,
    students,
  };
  plan.eligibilityContextVersion = userRepairContextVersion(students);
  plan.planHash = buildBackfillPlanHash(plan);
  return plan;
}

async function applyUserRepairPlan(plan) {
  const writes = plan.students
    .filter((student) => student.eligible)
    .flatMap((student) => student.writes)
    .filter((write) => write.diff.material);
  if (!writes.length) return 0;
  await bitacorasDb.runTransaction(async (transaction) => {
    const snapshots = [];
    for (const write of writes) {
      const ref = bitacorasDb.collection(write.collection).doc(write.docId);
      // All transaction reads happen before any write.
      // eslint-disable-next-line no-await-in-loop
      snapshots.push({ write, ref, snapshot: await transaction.get(ref) });
    }
    for (const item of snapshots) {
      if (technicalVersion(item.snapshot) !== item.write.version) {
        throw new BackfillRequestError("PLAN_STALE", 409);
      }
      transaction.set(item.ref, item.write.patch, { merge: true });
    }
  });
  return writes.length;
}

function backfillDb(project) {
  if (project === "source") return sourceDb;
  if (project === "bitacoras") return bitacorasDb;
  if (project === "rip") return ripDb;
  throw new BackfillRequestError("UNKNOWN_BACKFILL_PROJECT", 500);
}

async function applySafeBackfillPlan(plan) {
  let writes = 0;
  for (const student of plan.students) {
    if (!student.eligible) continue;
    for (const write of student.writes) {
      if (!write.diff.material) continue;
      // eslint-disable-next-line no-await-in-loop
      await backfillDb(write.project).collection(write.collection).doc(write.docId).set(write.patch, { merge: true });
      writes += 1;
    }
  }
  return writes;
}

async function executeSafeBackfill({ body, query, buildPlan, applyPlan }) {
  const request = validateBackfillRequestBody(body, query);
  const selectedBuildPlan = buildPlan ||
    (request.operation === USER_REPAIR_OPERATION ? buildUserRepairPlan : buildSafeBackfillPlan);
  const selectedApplyPlan = applyPlan ||
    (request.operation === USER_REPAIR_OPERATION ? applyUserRepairPlan : applySafeBackfillPlan);
  const plan = await selectedBuildPlan(request);
  if (request.mode === "dryRun") return publicBackfillPlan(plan);
  if (plan.planHash !== request.planHash) {
    throw new BackfillRequestError("PLAN_STALE", 409);
  }
  const appliedWrites = await selectedApplyPlan(plan);
  return {
    ...publicBackfillPlan(plan),
    mode: "apply",
    appliedWrites,
  };
}

/* =========================
   Registro público y efectos secundarios transitorios

   Firestore es la única fuente de verdad. Apps Script solo recibe desde este
   backend una copia administrativa y las órdenes de correo. Ningún resultado
   de esta integración cambia el éxito ya confirmado al navegador.
========================= */

const DOCUMENT_TYPES = new Set(["CC", "TI", "RC", "CE", "PAS", "PPT"]);
const REGISTRATION_SIDE_EFFECT_FIELDS = [
  "studentName", "studentDocument", "birthDate", "age", "studentCity",
  "studentAddress", "studentEmail", "phone", "mobile", "course",
  "instrument", "style", "emphasis", "interests", "selectedPlan",
  "modality", "eps", "rh", "guardianName", "guardianDocument",
  "guardianMobile", "guardianPhone", "guardianAddress", "relationship",
  "healthCondition", "termsAgreement", "termsReason",
  "imageUseAuthorization", "imageUseAuthorizationBy", "referredName",
  "referredMobile", "contactId",
];

function normalizeRegistrationEmail(value) {
  const email = toText(value).toLowerCase().replace(/\s+/g, "");
  if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return "";
  }
  return email;
}

function normalizeRegistrationDocument(documentType, documentNumber) {
  const type = toText(documentType).toUpperCase();
  const rawNumber = toText(documentNumber).toUpperCase().replace(/[\s.-]+/g, "");
  if (!DOCUMENT_TYPES.has(type)) return "";
  const valid = ["RC", "PAS"].includes(type)
    ? /^[A-Z0-9-]{4,30}$/.test(rawNumber)
    : /^\d{5,20}$/.test(rawNumber);
  return valid ? `${type}${rawNumber}` : "";
}

function duplicateResponse(duplicateByEmail, duplicateByDocument) {
  const byEmail = duplicateByEmail === true;
  const byDocument = duplicateByDocument === true;
  const duplicate = byEmail || byDocument;
  return {
    duplicate,
    duplicateByEmail: byEmail,
    duplicateByDocument: byDocument,
    canContinue: !duplicate,
    message: duplicate
      ? "Ya existe una inscripción con este correo o documento. Comunícate con administración si necesitas actualizarla."
      : "No se encontraron inscripciones duplicadas.",
  };
}

function clientRateLimitKey(request, action) {
  const rawRequest = request && request.rawRequest;
  const ip = toText(rawRequest && (rawRequest.ip || rawRequest.headers?.["x-forwarded-for"])) || "unknown";
  const userAgent = toText(rawRequest && rawRequest.headers?.["user-agent"]).slice(0, 200);
  return crypto.createHash("sha256").update(`${action}|${ip}|${userAgent}`).digest("hex");
}

async function enforceRegistrationRateLimit(request, action, maxPerMinute) {
  const now = Date.now();
  const windowId = Math.floor(now / 60000);
  const key = clientRateLimitKey(request, action);
  const ref = sourceDb.collection(RATE_LIMIT_COLLECTION).doc(`${key}_${windowId}`);
  await sourceDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const count = snap.exists ? Number((snap.data() || {}).count || 0) : 0;
    if (count >= maxPerMinute) {
      throw new HttpsError("resource-exhausted", "Demasiados intentos. Espera un minuto y vuelve a intentar.");
    }
    tx.set(ref, {
      action,
      count: count + 1,
      expiresAt: admin.firestore.Timestamp.fromMillis(now + (10 * 60000)),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

function appCheckMonitor(request, callableName) {
  if (!request.app) {
    logger.warn("Callable sin token App Check (modo monitor).", { callableName });
  }
}

async function findRegistrationDuplicate(email, normalizedDocument, secretValue) {
  const fingerprint = buildDocumentFingerprint(normalizedDocument, secretValue);
  const [emailSnap, documentSnap] = await Promise.all([
    sourceDb.collection(SOURCE_STUDENTS_COLLECTION)
      .where("studentEmail", "==", email)
      .limit(1)
      .get(),
    sourceDb.collection(DOCUMENT_INDEX_COLLECTION).doc(fingerprint).get(),
  ]);
  return duplicateResponse(!emailSnap.empty, documentSnap.exists);
}

exports.checkStudentRegistrationDuplicate = onCall(
  {
    region: "us-central1",
    timeoutSeconds: 20,
    memory: "256MiB",
    enforceAppCheck: false,
    secrets: [DOC_INDEX_SECRET],
  },
  async (request) => {
    appCheckMonitor(request, "checkStudentRegistrationDuplicate");
    await enforceRegistrationRateLimit(request, "duplicate_check", 20);

    const data = request.data || {};
    const email = normalizeRegistrationEmail(data.email);
    const normalizedDocument = normalizeRegistrationDocument(data.documentType, data.documentNumber);
    if (!email || !normalizedDocument) {
      throw new HttpsError("invalid-argument", "Correo, tipo y número de documento válidos son obligatorios.");
    }

    const secretValue = readDocSecret();
    if (!secretValue) {
      throw new HttpsError("unavailable", "La verificación de duplicados no está disponible temporalmente.");
    }

    try {
      return await findRegistrationDuplicate(email, normalizedDocument, secretValue);
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      logger.error("Falló la verificación privada de duplicados.", { code: toText(error && error.code) });
      throw new HttpsError("unavailable", "No fue posible verificar duplicados en este momento.");
    }
  }
);

function buildLegacyRegistrationPayload(raw, studentId) {
  const payload = {};
  for (const field of REGISTRATION_SIDE_EFFECT_FIELDS) {
    if (raw[field] !== undefined && raw[field] !== null) payload[field] = raw[field];
  }
  payload.studentId = studentId;
  payload.firebaseDocumentId = studentId;
  return payload;
}

function missingSideEffectActions(job) {
  const data = job || {};
  return {
    syncSheet: data.sheetSynced !== true,
    sendWelcomeEmail: data.welcomeEmailSent !== true,
    sendInternalNotification: data.internalNotificationSent !== true,
  };
}

function mergeSideEffectResult(job, legacyResult) {
  const current = job || {};
  const result = legacyResult || {};
  return {
    sheetSynced: current.sheetSynced === true || result.sheetSynced === true,
    welcomeEmailSent: current.welcomeEmailSent === true || result.welcomeEmailSent === true,
    internalNotificationSent: current.internalNotificationSent === true || result.internalNotificationSent === true,
  };
}

function sideEffectStatus(result) {
  const values = [result.sheetSynced, result.welcomeEmailSent, result.internalNotificationSent];
  if (values.every(Boolean)) return "completed";
  if (values.some(Boolean)) return "partial";
  return "failed";
}

function safeLegacyErrorCode(error) {
  const raw = toText(error && (error.code || error.name || error.message) ?
    (error.code || error.name || error.message) : error);
  return raw.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 100) || "LEGACY_UNKNOWN";
}

function legacyError(code, extra) {
  const error = new Error(code);
  error.code = code;
  if (extra) Object.assign(error, extra);
  return error;
}

// La URL del adaptador SIEMPRE debe ser la implementación publicada `/exec`.
// `/dev` sirve la "cabeza" no versionada del editor y jamás debe usarse en
// producción: se rechaza explícitamente para no depender de una config buena.
function assertLegacyExecUrl(url) {
  const safe = toText(url);
  if (!safe) throw legacyError("LEGACY_CONFIGURATION_MISSING");
  if (/\/dev\/?($|\?)/.test(safe) || !/\/exec\/?($|\?)/.test(safe)) {
    throw legacyError("LEGACY_URL_NOT_EXEC");
  }
  return safe;
}

/*
  Interpreta la respuesta del adaptador Apps Script. PURA y testeable: no toca
  red ni secretos. Reglas (Paso 1 del despliegue controlado):
  - HTTP fuera de 2xx  → fallo LEGACY_HTTP_<status>;
  - cuerpo no-JSON     → fallo LEGACY_NON_JSON;
  - body.ok !== true   → fallo con el errorCode del cuerpo (o LEGACY_REJECTED);
    nunca se considera éxito por el solo hecho de que el HTTP sea 200.
  Solo se conservan las tres banderas booleanas del resultado (nunca el
  payload completo del estudiante ni datos privados).
*/
function parseLegacyResponse({ okHttp, status, bodyText }) {
  if (!okHttp) {
    throw legacyError(`LEGACY_HTTP_${status}`);
  }
  let result;
  try {
    result = JSON.parse(toText(bodyText));
  } catch (_error) {
    throw legacyError("LEGACY_NON_JSON");
  }
  if (!result || typeof result !== "object" || result.ok !== true) {
    const code = toText(result && result.errorCode) || "LEGACY_REJECTED";
    throw legacyError(code, {
      legacyResult: {
        sheetSynced: Boolean(result && result.sheetSynced),
        welcomeEmailSent: Boolean(result && result.welcomeEmailSent),
        internalNotificationSent: Boolean(result && result.internalNotificationSent),
        errorCode: code,
      },
    });
  }
  return {
    ok: true,
    sheetSynced: Boolean(result.sheetSynced),
    welcomeEmailSent: Boolean(result.welcomeEmailSent),
    internalNotificationSent: Boolean(result.internalNotificationSent),
  };
}

async function callLegacyAppsScript(envelope) {
  const url = assertLegacyExecUrl(LEGACY_APPS_SCRIPT_URL.value());
  const token = toText(LEGACY_APPS_SCRIPT_TOKEN.value());
  if (!token) throw legacyError("LEGACY_CONFIGURATION_MISSING");

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      redirect: "follow",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ...envelope, token }),
      signal: AbortSignal.timeout(25000),
    });
  } catch (error) {
    // Timeout (AbortError/TimeoutError) o error de red: fallo → activa retry.
    const isTimeout = /Timeout|Abort/i.test(toText(error && (error.name || error.code)));
    throw legacyError(isTimeout ? "LEGACY_TIMEOUT" : "LEGACY_NETWORK_ERROR");
  }

  const bodyText = await response.text().catch(() => "");
  return parseLegacyResponse({ okHttp: response.ok, status: response.status, bodyText });
}

async function beginIntegrationJob(studentId) {
  const ref = sourceDb.collection(INTEGRATION_JOBS_COLLECTION).doc(studentId);
  return sourceDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists ? snap.data() || {} : {};
    if (existing.status === "completed") return existing;
    const next = {
      studentId,
      type: "legacy_registration_side_effects",
      status: "processing",
      sheetSynced: existing.sheetSynced === true,
      welcomeEmailSent: existing.welcomeEmailSent === true,
      internalNotificationSent: existing.internalNotificationSent === true,
      attempts: Number(existing.attempts || 0) + 1,
      lastErrorCode: "",
      createdAt: existing.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    tx.set(ref, next, { merge: true });
    return next;
  });
}

async function processStudentSideEffects(raw, studentId) {
  const ref = sourceDb.collection(INTEGRATION_JOBS_COLLECTION).doc(studentId);
  const job = await beginIntegrationJob(studentId);
  if (job.status === "completed") return job;

  const envelope = {
    eventType: "student_registration",
    studentId,
    idempotencyKey: `student_registration:${studentId}`,
    actions: missingSideEffectActions(job),
    payload: buildLegacyRegistrationPayload(raw || {}, studentId),
  };

  try {
    const legacyResult = await callLegacyAppsScript(envelope);
    const merged = mergeSideEffectResult(job, legacyResult);
    const status = sideEffectStatus(merged);
    await ref.set({
      ...merged,
      status,
      lastErrorCode: "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    if (status !== "completed") {
      const error = new Error("LEGACY_PARTIAL_RESULT");
      error.code = "LEGACY_PARTIAL_RESULT";
      error.legacyResult = legacyResult;
      throw error;
    }
    return { ...job, ...merged, status };
  } catch (error) {
    const merged = mergeSideEffectResult(job, error.legacyResult);
    const code = safeLegacyErrorCode(error);
    // Log técnico RESUMIDO: solo studentId y código acotado, nunca el payload.
    logger.warn("Efecto secundario legado falló; se reintentará.", buildTechnicalLog({
      studentId,
      status: "retry",
      operations: ["legacy_side_effects"],
      code,
    }));
    await ref.set({
      ...merged,
      status: sideEffectStatus(merged),
      lastErrorCode: code,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    throw error;
  }
}

exports.processStudentRegistrationSideEffects = onDocumentCreated(
  {
    document: `${SOURCE_STUDENTS_COLLECTION}/{studentId}`,
    region: "us-central1",
    timeoutSeconds: 60,
    memory: "256MiB",
    secrets: [LEGACY_APPS_SCRIPT_URL, LEGACY_APPS_SCRIPT_TOKEN],
    retry: true,
  },
  async (event) => {
    const raw = event.data ? event.data.data() || {} : {};
    await processStudentSideEffects(raw, event.params.studentId);
  }
);

exports.createTermsRejectedEvent = onCall(
  {
    region: "us-central1",
    timeoutSeconds: 15,
    memory: "256MiB",
    enforceAppCheck: false,
  },
  async (request) => {
    appCheckMonitor(request, "createTermsRejectedEvent");
    await enforceRegistrationRateLimit(request, "terms_rejected", 10);
    const data = request.data || {};
    const email = normalizeRegistrationEmail(data.email);
    const studentName = toText(data.studentName).replace(/\s+/g, " ").slice(0, 160);
    if (!email || !studentName) {
      throw new HttpsError("invalid-argument", "Nombre y correo válidos son obligatorios.");
    }
    const ref = await sourceDb.collection(REGISTRATION_EVENTS_COLLECTION).add({
      type: "terms_rejected",
      email,
      studentName,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { accepted: true, eventId: ref.id };
  }
);

exports.processRegistrationEvent = onDocumentCreated(
  {
    document: `${REGISTRATION_EVENTS_COLLECTION}/{eventId}`,
    region: "us-central1",
    timeoutSeconds: 30,
    memory: "256MiB",
    secrets: [LEGACY_APPS_SCRIPT_URL, LEGACY_APPS_SCRIPT_TOKEN],
    retry: true,
  },
  async (event) => {
    const raw = event.data ? event.data.data() || {} : {};
    if (raw.type !== "terms_rejected") return;
    await callLegacyAppsScript({
      eventType: "terms_rejected",
      idempotencyKey: `terms_rejected:${event.params.eventId}`,
      payload: {
        email: normalizeRegistrationEmail(raw.email),
        studentName: toText(raw.studentName).slice(0, 160),
      },
    });
  }
);

/* =========================
   Triggers y endpoints
========================= */

exports.syncStudentIdentity = onDocumentWritten(
  {
    document: `${SOURCE_STUDENTS_COLLECTION}/{studentId}`,
    region: "us-central1",
    timeoutSeconds: 60,
    memory: "256MiB",
    secrets: [DOC_INDEX_SECRET],
    // Reintentos seguros del runtime: todas las escrituras son merges
    // idempotentes, reintentar no duplica.
    retry: true,
  },
  async (event) => {
    const startedAt = Date.now();
    const eventId = toText(event.id);
    const sourceDocId = event.params.studentId;
    if (!event.data || !event.data.after.exists) {
      logger.info("Cambio de identidad ignorado.", buildTechnicalLog({
        eventId,
        studentId: sourceDocId,
        status: "no_op_deleted",
        durationMs: Date.now() - startedAt,
        operations: [],
      }));
      return;
    }

    const beforeExists = Boolean(event.data.before && event.data.before.exists);
    const before = beforeExists ? event.data.before.data() || {} : {};
    const after = event.data.after.data() || {};
    const decision = identityChangeDecision({
      beforeExists,
      afterExists: true,
      before,
      after,
      sourceDocId,
    });

    if (!decision.shouldSync) {
      logger.info("Cambio de identidad sin operaciones.", buildTechnicalLog({
        eventId,
        studentId: sourceDocId,
        status: "no_op",
        durationMs: Date.now() - startedAt,
        operations: [],
        code: decision.reason,
        counts: { writes: 0 },
      }));
      return;
    }

    try {
      const result = await mirrorStudentDoc(after, sourceDocId);

      await writeSyncStatus({
        ok: true,
        lastEvent: "syncStudentIdentity",
        lastStudentId: maskTechnicalId(sourceDocId),
        lastResult: result,
        version: SCHEMA_VERSION,
      });

      logger.info("Identidad sincronizada.", buildTechnicalLog({
        eventId,
        studentId: sourceDocId,
        status: result.status,
        durationMs: Date.now() - startedAt,
        operations: result.operations,
        counts: {
          writes: result.operations.filter((operation) => !operation.endsWith("_skipped")).length,
          recipients: result.counts?.recipients || 0,
          idConflicts: result.idConflict ? 1 : 0,
        },
      }));
    } catch (error) {
      const code = safeTechnicalCode(error);
      logger.error("syncStudentIdentity falló.", buildTechnicalLog({
        eventId,
        studentId: sourceDocId,
        status: "failed",
        durationMs: Date.now() - startedAt,
        operations: ["identity_sync"],
        code,
      }));
      await logSyncError("syncStudentIdentity", error, {
        sourceDocId,
      });
      await writeSyncStatus({
        ok: false,
        lastEvent: "syncStudentIdentity",
        lastStudentId: maskTechnicalId(sourceDocId),
        lastErrorCode: code,
      });
      // Se relanza para que el runtime reintente con backoff si está habilitado.
      throw error;
    }
  }
);

/*
  Endpoint administrativo. Preferencia a futuro: invocación restringida por
  IAM (--no-allow-unauthenticated + roles/run.invoker) o script con ADC; ver
  DEPLOYMENT.md. Mientras tanto: método POST obligatorio y token SOLO por
  header (nunca en query string, para que no quede en logs de acceso).
  El token vive en Secret Manager como BACKFILL_IDENTITY_TOKEN. El valor
  anterior se considera comprometido y no se reutiliza.
*/
function isAuthorizedAdminRequest(req) {
  if (!req || req.method !== "POST") return false;
  const expectedToken = toText(BACKFILL_IDENTITY_TOKEN.value());
  if (!expectedToken) return false;
  // Cualquier token en query string invalida la petición (quedaría en logs
  // de acceso), aunque el valor fuera correcto.
  if (toText(req.query && req.query.token)) return false;
  const providedToken = toText(typeof req.get === "function" ? req.get("x-sync-token") : "");
  return providedToken === expectedToken;
}

exports.backfillStudentIdentity = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "512MiB",
    secrets: [DOC_INDEX_SECRET, BACKFILL_IDENTITY_TOKEN],
  },
  async (req, res) => {
    const startedAt = Date.now();
    try {
      if (!isAuthorizedAdminRequest(req)) {
        res.status(403).json({ ok: false, code: "BACKFILL_UNAUTHORIZED" });
        return;
      }

      const safeResult = await executeSafeBackfill({ body: req.body, query: req.query || {} });
      logger.info("Backfill processed.", buildTechnicalLog({
        eventId: req.id,
        runId: safeResult.runId,
        status: safeResult.mode === "dryRun" ? "dry_run" : "applied",
        durationMs: Date.now() - startedAt,
        operations: ["identity_sync"],
        counts: {
          writes: safeResult.mode === "dryRun"
            ? safeResult.counts.proposedWrites
            : safeResult.appliedWrites,
        },
      }));
      res.json(safeResult);
    } catch (error) {
      const code = safeBackfillErrorCode(error);
      logger.error("Backfill rejected.", buildTechnicalLog({
        eventId: req.id,
        runId: req.body && req.body.runId,
        status: "failed",
        durationMs: Date.now() - startedAt,
        operations: ["identity_sync"],
        code,
        counts: { writes: 0 },
      }));
      res.status(error instanceof BackfillRequestError ? error.httpStatus : 500).json({
        ok: false,
        code,
      });
    }
  }
);

exports.diagnoseStudentAccess = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 60,
    memory: "256MiB",
    secrets: [BACKFILL_IDENTITY_TOKEN],
  },
  async (req, res) => {
    try {
      if (!isAuthorizedAdminRequest(req)) {
        res.status(403).json({ ok: false, code: "DIAGNOSTIC_UNAUTHORIZED" });
        return;
      }

      const email = userDocId(req.body && req.body.email);
      if (!email) {
        res.status(400).json({ ok: false, code: "DIAGNOSTIC_EMAIL_REQUIRED" });
        return;
      }

      const userSnap = await bitacorasDb.collection(TARGET_USERS_COLLECTION).doc(email).get();
      const user = userSnap.exists ? userSnap.data() || {} : null;
      const studentIds = uniqueTexts([
        ...(Array.isArray(user?.studentIds) ? user.studentIds : []),
        user?.studentId,
        user?.studentKey,
      ]);

      let existingStudentCount = 0;
      for (const studentId of studentIds.slice(0, 20)) {
        // eslint-disable-next-line no-await-in-loop
        const studentSnap = await bitacorasDb.collection(TARGET_STUDENTS_COLLECTION).doc(studentId).get();
        if (studentSnap.exists) existingStudentCount += 1;
      }

      let bitacoraCount = 0;
      for (let index = 0; index < studentIds.length; index += 10) {
        const part = studentIds.slice(index, index + 10);
        if (!part.length) continue;
        // eslint-disable-next-line no-await-in-loop
        const snap = await bitacorasDb
          .collection("bitacoras")
          .where("studentIds", "array-contains-any", part)
          .limit(50)
          .get();
        bitacoraCount += snap.size;
      }

      const shouldBeActive = Boolean(user) &&
        studentIds.length > 0 &&
        isAllowedStudentStatus(user.studentStatus || user.estado || user.status);

      res.json({
        ok: true,
        userExists: Boolean(user),
        active: user ? user.active !== false : false,
        shouldBeActive,
        linkedStudentCount: studentIds.length,
        existingStudentCount,
        visibleBitacoraSampleCount: bitacoraCount,
        writes: 0,
      });
    } catch (error) {
      logger.error("Diagnostico de acceso fallo.", buildTechnicalLog({
        eventId: req.id,
        status: "failed",
        operations: ["read_only_diagnostic"],
        code: safeTechnicalCode(error),
        counts: { writes: 0 },
      }));
      res.status(500).json({
        ok: false,
        code: "DIAGNOSTIC_FAILED",
      });
    }
  }
);

/*
  Unificación manual de inscripciones fuente.

  No borra el duplicado: lo archiva y conserva el vínculo hacia el canónico.
  Los correos encontrados se guardan en el canónico como alternateEmails y el
  trigger normal de identidad los replica a los directorios consumidores.
*/
exports.mergeStudentDuplicate = onCall(
  { region: "us-central1", timeoutSeconds: 30, memory: "256MiB" },
  async (request) => {
    const email = toText(request.auth && request.auth.token && request.auth.token.email).toLowerCase();
    if (!request.auth || !STUDENT_DIRECTORY_MERGE_EMAILS.has(email)) {
      throw new HttpsError("permission-denied", "No tienes permiso para unificar estudiantes.");
    }

    const canonicalStudentId = toText(request.data && request.data.canonicalStudentId);
    const duplicateStudentId = toText(request.data && request.data.duplicateStudentId);
    const confirmedSamePerson = request.data && request.data.confirmedSamePerson === true;
    if (!canonicalStudentId || !duplicateStudentId || canonicalStudentId === duplicateStudentId) {
      throw new HttpsError("invalid-argument", "Selecciona dos registros distintos.");
    }
    if (!confirmedSamePerson) {
      throw new HttpsError("failed-precondition", "Debes confirmar que revisaste la identidad.");
    }

    const [canonicalSnap, duplicateSnap] = await Promise.all([
      sourceDb.collection(SOURCE_STUDENTS_COLLECTION).doc(canonicalStudentId).get(),
      sourceDb.collection(SOURCE_STUDENTS_COLLECTION).doc(duplicateStudentId).get(),
    ]);
    if (!canonicalSnap.exists || !duplicateSnap.exists) {
      throw new HttpsError("not-found", "No se encontraron ambos registros en el directorio.");
    }
    const canonical = canonicalSnap.data() || {};
    const duplicate = duplicateSnap.data() || {};
    if (duplicate.identityMergeStatus === "archived_duplicate") {
      throw new HttpsError("failed-precondition", "El registro secundario ya fue unificado.");
    }

    const canonicalName = normalizeText(firstText(canonical.studentName, canonical.nombre, canonical.name));
    const duplicateName = normalizeText(firstText(duplicate.studentName, duplicate.nombre, duplicate.name));
    const canonicalDocuments = collectDocumentValues(canonical);
    const sharesDocument = [...canonicalDocuments].some((value) => collectDocumentValues(duplicate).has(value));
    if (!sharesDocument && (!canonicalName || canonicalName !== duplicateName)) {
      throw new HttpsError("failed-precondition", "Los registros no comparten evidencia suficiente para unirlos.");
    }

    const allEmails = extractEmails(
      canonical.studentEmail, canonical.email, canonical.correo, canonical.emails,
      canonical.alternateEmails, canonical.allEmails,
      duplicate.studentEmail, duplicate.email, duplicate.correo, duplicate.emails,
      duplicate.alternateEmails, duplicate.allEmails
    );
    const now = admin.firestore.FieldValue.serverTimestamp();
    const batch = sourceDb.batch();
    batch.set(canonicalSnap.ref, {
      alternateEmails: allEmails.filter((value) => value !== toText(canonical.studentEmail).toLowerCase()),
      allEmails,
      mergedSourceStudentIds: uniqueTexts([
        ...(Array.isArray(canonical.mergedSourceStudentIds) ? canonical.mergedSourceStudentIds : []),
        duplicateStudentId,
      ]),
      identityMerge: { status: "canonical", updatedAt: now, updatedBy: email },
      updatedAt: now,
    }, { merge: true });
    batch.set(duplicateSnap.ref, {
      identityMergeStatus: "archived_duplicate",
      canonicalStudentId,
      archivedFromDirectory: true,
      archivedAt: now,
      archivedBy: email,
      alternateEmails: allEmails,
      updatedAt: now,
    }, { merge: true });
    await batch.commit();
    historicalDirectoryCache = { expiresAt: 0, payload: null };
    logger.info("Duplicado de estudiante unificado manualmente.", buildTechnicalLog({
      eventId: request.rawRequest && request.rawRequest.id,
      studentId: canonicalStudentId,
      status: "merged",
      durationMs: 0,
      operations: ["identity_sync"],
      counts: { writes: 2 },
    }));
    return { ok: true, canonicalStudentId, archivedStudentId: duplicateStudentId, emailCount: allEmails.length };
  }
);

/*
  Complemento histórico para la Lista de Estudiantes.

  Es callable para que Firebase valide el ID token del proyecto
  estudiantes-musicala. Solo las cuatro cuentas operativas reciben datos. La
  función consulta ambas fuentes, resuelve duplicados con evidencia y devuelve
  exclusivamente filas resumidas de solo lectura. No realiza escrituras.
*/
exports.listHistoricalStudents = onCall(
  {
    region: "us-central1",
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (request) => {
    const email = toText(request.auth && request.auth.token && request.auth.token.email).toLowerCase();
    if (!request.auth || !STUDENT_DIRECTORY_EMAILS.has(email)) {
      throw new HttpsError("permission-denied", "Cuenta no autorizada para consultar el directorio.");
    }

    const refreshRequested = request.data && request.data.refresh === true;
    if (!refreshRequested && historicalDirectoryCache.payload && historicalDirectoryCache.expiresAt > Date.now()) {
      return historicalDirectoryCache.payload;
    }

    try {
      const [sourceSnapshot, bitacorasSnapshot] = await Promise.all([
        sourceDb.collection(SOURCE_STUDENTS_COLLECTION).get(),
        bitacorasDb.collection(TARGET_STUDENTS_COLLECTION).get(),
      ]);
      const sourceRecords = sourceSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      const bitacorasRecords = bitacorasSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      const result = buildHistoricalDirectory(sourceRecords, bitacorasRecords);

      logger.info("Directorio historico consultado.", buildTechnicalLog({
        eventId: request.rawRequest && request.rawRequest.id,
        status: "ok",
        operations: ["read_only_historical_directory"],
        counts: {
          writes: 0,
          sourceDocuments: result.counts.sourceDocuments,
          historicalStudents: result.counts.historicalStudents,
        },
      }));

      const payload = {
        ok: true,
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        students: result.students,
        counts: result.counts,
        writes: 0,
      };
      historicalDirectoryCache = {
        expiresAt: Date.now() + HISTORICAL_DIRECTORY_CACHE_MS,
        payload,
      };
      return payload;
    } catch (error) {
      logger.error("Fallo el directorio historico.", buildTechnicalLog({
        eventId: request.rawRequest && request.rawRequest.id,
        status: "failed",
        operations: ["read_only_historical_directory"],
        code: safeTechnicalCode(error),
        counts: { writes: 0 },
      }));
      throw new HttpsError("internal", "No se pudo consultar el directorio historico.");
    }
  }
);

// Internos expuestos solo para pruebas unitarias (node test/).
exports._internals = {
  normalizeStudent,
  normalizeProcesses,
  mergeProcesses,
  resolvePedagogicalProfileFields,
  isAllowedStudentStatus,
  uniqueTexts,
  extractEmails,
  normalizeText,
  ripOwnsStatus,
  collectDocumentValues,
  looksLikeDocumentNumber,
  filterSensitiveAliases,
  normalizeDocumentForFingerprint,
  buildDocumentFingerprint,
  fingerprintDecision,
  identityRelevantFingerprint,
  identityChangeDecision,
  maskTechnicalId,
  safeTechnicalCode,
  buildTechnicalLog,
  normalizeRegistrationEmail,
  normalizeRegistrationDocument,
  duplicateResponse,
  buildLegacyRegistrationPayload,
  missingSideEffectActions,
  mergeSideEffectResult,
  sideEffectStatus,
  safeLegacyErrorCode,
  parseLegacyResponse,
  assertLegacyExecUrl,
  BackfillRequestError,
  validBackfillStudentId,
  validateBackfillRequestBody,
  backfillCanonicalValue,
  backfillValuesEqual,
  backfillValueContains,
  backfillPatchDiff,
  makeBackfillWrite,
  safeBackfillErrorCode,
  buildBackfillPlanHash,
  publicBackfillPlan,
  minimalBitacorasIdentityPatch,
  minimalRipIdentityPatch,
  minimalUserIdentityPatch,
  userDocId,
  firestoreTimestampFromRfc3339,
  buildUserRepairPlan,
  applyUserRepairPlan,
  executeSafeBackfill,
};

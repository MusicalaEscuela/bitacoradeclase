"use strict";

/* =============================================================================
  syncStudentStatus — Cloud Functions desplegadas en `rip-musicala`.

  Flujo: RIP recalcula studentComputed/{docId}
    → esta función resuelve el studentId canónico
    → publica una proyección SEGURA (sin datos financieros sensibles) en:
        bitacoras-de-clase/students/{studentId}.rip
    → actualiza el acceso derivado en bitacoras-de-clase/users (active,
      studentStatus) para los usuarios vinculados a ese estudiante.

  Contrato:
  - RIP es la ÚNICA fuente de verdad del estado operativo.
  - Solo se publican los campos listados en buildStatusProjection().
    Nunca saldos en dinero, pagos ni movimientos completos.
  - La traducción estado → permisos está centralizada en
    derivePermissionsFromStatus() (editar SOLO ahí la política).
  - Escrituras idempotentes (merge sobre rutas de campo). Reejecutar la
    función o el backfill no duplica ni corrompe datos.
  - Si el doc studentComputed no puede resolverse a un studentId canónico,
    NO se publica nada: queda registrado en sync_logs para revisión.

  IAM requerido (ver DEPLOYMENT.md):
  - La cuenta de servicio de estas funciones necesita roles/datastore.user
    sobre bitacoras-de-clase.
============================================================================= */

const admin = require("firebase-admin");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

const SOURCE_PROJECT_ID = "rip-musicala";
const TARGET_PROJECT_ID = "bitacoras-de-clase";
const LIST_PROJECT_ID = "estudiantes-musicala";
const RUNTIME_SERVICE_ACCOUNT = "rip-status-sync@rip-musicala.iam.gserviceaccount.com";

const COMPUTED_COLLECTION = "studentComputed";
const RIP_STUDENTS_COLLECTION = "students";
const TARGET_STUDENTS_COLLECTION = "students";
const TARGET_USERS_COLLECTION = "users";
const SYNC_LOGS_COLLECTION = "sync_logs";
const SYNC_META_COLLECTION = "app_config";
const SYNC_META_DOC = "rip_status_sync_status";

const SCHEMA_VERSION = 2;
const STUDENT_ROLES = new Set(["student", "estudiante", "acudiente", "guardian", "parent"]);

admin.initializeApp({ projectId: SOURCE_PROJECT_ID });

const targetApp = admin.initializeApp(
  { projectId: TARGET_PROJECT_ID },
  "bitacoras-target"
);
const listApp = admin.initializeApp(
  { projectId: LIST_PROJECT_ID },
  "student-list-target"
);

const ripDb = admin.firestore();
const targetDb = targetApp.firestore();
const listDb = listApp.firestore();

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

function firstOf(list) {
  return Array.isArray(list) && list.length ? toText(list[0]) : "";
}

function uniqueTextList(values) {
  const seen = new Set();
  return values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map(toText)
    .filter((value) => {
      const key = normalizeText(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Un studentId canónico es un ID de documento de Firestore (auto-ID) del
// proyecto estudiantes-musicala. Heurística SOLO para diagnóstico; la
// resolución real usa campos explícitos.
function looksLikeAutoId(value) {
  return /^[A-Za-z0-9]{18,28}$/.test(toText(value)) && /[A-Z]/.test(toText(value));
}

/* =========================
   POLÍTICA CENTRAL estado → permisos (ÚNICA en todo el ecosistema).
   Editar SOLO aquí. Bitácoras y el HUB OBEDECEN estos campos publicados;
   ningún frontend vuelve a interpretar el texto del estado.

   Matriz (documentada en DATA_CONTRACT.md):

   | Estado                          | operational | canAccessHub | accountEnabled | teacherLists | bitacoras |
   |---------------------------------|-------------|--------------|----------------|--------------|-----------|
   | Activo / no registro / en pausa |     ✔       |      ✔       |       ✔        |      ✔       |     ✔     |
   | Inactivo en pausa (1-3 meses)   |     ✘       |      ✔       |       ✔        |      ✔       |     ✔     |
   | Inactivo >3m / hist / exestud.  |     ✘       |      ✘       |       ✘        |      ✘       |     ✘     |
   | Archivado / bloqueado           |     ✘       |      ✘       |       ✘        |      ✘       |     ✘     |

   Conserva el comportamiento operativo previo (users.active ya negaba a los
   inactivos de más de 3 meses): NO amplía el acceso de exestudiantes.
========================= */

function derivePermissionsFromStatus(statusLabel) {
  const status = normalizeText(statusLabel).replace(/[‐-―−]/g, "-");

  const isActive =
    status === "activo" ||
    status.startsWith("activo no registro") ||
    status.startsWith("activo en pausa");

  const isShortPause =
    status.startsWith("inactivo en pausa") &&
    (/1\s*-\s*3/.test(status) || /1\s+a\s+3/.test(status));

  const enabled = isActive || isShortPause;

  return {
    operationalActive: isActive,
    canAccessHub: enabled,
    accountEnabled: enabled,
    showInTeacherLists: enabled,
    canReceiveBitacoras: enabled,
    // Compatibilidad: `active` plano == operationalActive en students.
    active: isActive,
  };
}

function statusCodeFromLabel(statusLabel) {
  const code = normalizeText(statusLabel)
    .replace(/[‐-―−]/g, "-")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return code || "sin_estado";
}

/* =========================
   Resolución del studentId canónico
========================= */

async function resolveCanonicalStudentId(docId, computed) {
  const explicit = toText(computed.canonicalStudentId);
  if (explicit) return { studentId: explicit, source: "canonicalStudentId" };

  // students/{docId} en RIP puede ser: (a) el doc canónico creado por el sync
  // de identidad (studentId === docId), o (b) un doc legado por nombre con el
  // campo officialStudentId anotado.
  const studentSnap = await ripDb.collection(RIP_STUDENTS_COLLECTION).doc(docId).get();
  if (studentSnap.exists) {
    const student = studentSnap.data() || {};
    const official = toText(student.officialStudentId);
    if (official) {
      return {
        studentId: official,
        source: official === docId ? "students_canonical" : "students_officialStudentId",
      };
    }
    if (toText(student.identitySource) === "estudiantes-musicala" && toText(student.studentId) === docId) {
      return { studentId: docId, source: "students_identity" };
    }

    // Los documentos legados de RIP se identificaban por nameKey y no traen
    // officialStudentId. Se resuelven exclusivamente si el nombre conduce a
    // UN solo documento canónico ya vinculado con Lista. Si hay 0 o más de 1,
    // no se publica: es preferible una revisión a asociar otra persona.
    const legacyNameKey = toText(student.nameKey || student.normalizedName || student.name || computed.estudiante);
    const keys = uniqueTextList([legacyNameKey, normalizeText(legacyNameKey)]);
    const candidateIds = new Set();
    for (const key of keys) {
      // eslint-disable-next-line no-await-in-loop
      const [byNameKey, byNormalizedName] = await Promise.all([
        ripDb.collection(RIP_STUDENTS_COLLECTION).where("nameKey", "==", key).limit(10).get(),
        ripDb.collection(RIP_STUDENTS_COLLECTION).where("normalizedName", "==", key).limit(10).get(),
      ]);
      for (const candidate of [...byNameKey.docs, ...byNormalizedName.docs]) {
        const officialCandidate = toText((candidate.data() || {}).officialStudentId);
        if (officialCandidate) candidateIds.add(officialCandidate);
      }
    }
    if (candidateIds.size === 1) {
      return { studentId: [...candidateIds][0], source: "legacy_namekey_unique" };
    }
    if (candidateIds.size > 1) {
      return { studentId: "", source: "legacy_namekey_ambiguous" };
    }
  }

  // Diagnóstico: el docId ya parece un auto-ID canónico (post-migración).
  if (looksLikeAutoId(docId)) {
    return { studentId: docId, source: "docid_heuristic" };
  }

  return { studentId: "", source: "unresolved" };
}

/* =========================
   Proyección segura hacia Bitácoras
========================= */

function buildStatusProjection(studentId, computed, statusVersion) {
  const statusLabel = toText(computed.clasificacionFinal) || "Sin estado";
  const permissions = derivePermissionsFromStatus(statusLabel);
  const remaining = safeNumber(computed.saldo);

  return {
    studentId,
    statusCode: statusCodeFromLabel(statusLabel),
    statusLabel,
    statusReason: toText(computed.statusReason) ||
      (toText(computed.ultimaClase)
        ? `Última clase registrada: ${toText(computed.ultimaClase)}`
        : "Sin clases registradas"),
    operationalActive: permissions.operationalActive,
    accountEnabled: permissions.accountEnabled,
    active: permissions.operationalActive,
    canAccessHub: permissions.canAccessHub,
    showInTeacherLists: permissions.showInTeacherLists,
    canReceiveBitacoras: permissions.canReceiveBitacoras,
    lastClassDate: toText(computed.ultimaClase),
    nextClassDate: toText(computed.nextClassDate),
    remainingClasses: remaining,
    // Interés/enfoque calculado por RIP. Se mantienen los nombres en español
    // que ya usa el ecosistema (curso/instrumento/estilo/enfasis).
    curso: firstOf(computed.cursos) || toText(computed.curso),
    instrumento: firstOf(computed.instrumentos) || toText(computed.instrumento),
    estilo: firstOf(computed.estilos) || toText(computed.estilo),
    enfasis: Array.isArray(computed.enfasis) ? firstOf(computed.enfasis) : toText(computed.enfasis),
    cursos: Array.isArray(computed.cursos) ? computed.cursos : [],
    instrumentos: Array.isArray(computed.instrumentos) ? computed.instrumentos : [],
    estilos: Array.isArray(computed.estilos) ? computed.estilos : [],
    // Etiquetas de lectura para la Lista. No reemplazan los campos detallados
    // anteriores; permiten mostrar las áreas y técnicas que RIP ha detectado,
    // sin tocar la inscripción original.
    areas: uniqueTextList([computed.cursos, computed.curso]),
    tecnicas: uniqueTextList([
      computed.instrumentos,
      computed.instrumento,
      computed.estilos,
      computed.estilo,
      computed.enfasis,
    ]),
    ripUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    statusSource: SOURCE_PROJECT_ID,
    statusVersion,
    schemaVersion: SCHEMA_VERSION,
  };
}

/* =========================
   Escrituras
========================= */

// Versión determinista: milisegundos del updatedAt del doc computado (o del
// evento). Reintentar el mismo evento produce la MISMA versión: idempotente.
function deriveStatusVersion(computed, eventTimeMillis) {
  const updatedAt = computed && computed.updatedAt;
  if (updatedAt && typeof updatedAt.toMillis === "function") return updatedAt.toMillis();
  if (updatedAt && typeof updatedAt.seconds === "number") {
    return updatedAt.seconds * 1000 + Math.round((updatedAt.nanoseconds || 0) / 1e6);
  }
  return safeNumber(eventTimeMillis) || Date.now();
}

async function publishStatus(studentId, computed, context = {}) {
  const statusVersion = deriveStatusVersion(computed, context.eventTimeMillis);
  const projection = buildStatusProjection(studentId, computed, statusVersion);

  const studentRef = targetDb.collection(TARGET_STUDENTS_COLLECTION).doc(studentId);
  const snap = await studentRef.get();
  const existing = snap.exists ? snap.data() || {} : {};

  // Idempotencia/orden: no se pisa una publicación más nueva (backfill viejo
  // corriendo en paralelo con el trigger, por ejemplo).
  const existingVersion = safeNumber(existing?.rip?.statusVersion);
  if (existingVersion && existingVersion > statusVersion) {
    return { skipped: true, reason: "older_version", studentId };
  }

  // Solo campos propiedad de RIP: el mapa `rip` completo + los planos de
  // compatibilidad de estado. La identidad (mapa identity, nombre, correos)
  // NUNCA se toca desde aquí. `active` plano en students == operationalActive.
  await studentRef.set(
    {
      rip: projection,
      estado: projection.statusLabel,
      status: projection.statusLabel,
      active: projection.operationalActive,
      showInTeacherLists: projection.showInTeacherLists,
      statusSource: SOURCE_PROJECT_ID,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(snap.exists ? {} : {
        studentId,
        studentIds: [studentId],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: "syncStudentStatus",
      }),
    },
    { merge: true }
  );

  const listResult = await publishListProjection(studentId, projection);

  const usersUpdated = await updateLinkedUsers(studentId, projection);

  return {
    skipped: false,
    studentId,
    statusLabel: projection.statusLabel,
    active: projection.active,
    usersUpdated,
    listResult,
    resolution: context.resolution || "",
  };
}

// La Lista sigue siendo dueña de la identidad y de los datos del formulario.
// RIP solo escribe su mapa `rip` y los aliases planos de estado que la interfaz
// ya usa. Nunca se crean documentos desde RIP: una identidad ausente queda
// fuera para revisión, en lugar de fabricar una fila incompleta.
async function publishListProjection(studentId, projection) {
  const studentRef = listDb.collection("estudiantes").doc(studentId);
  const snap = await studentRef.get();
  if (!snap.exists) return { skipped: true, reason: "missing_list_student" };

  const existingVersion = safeNumber((snap.data() || {})?.rip?.statusVersion);
  if (existingVersion && existingVersion > projection.statusVersion) {
    return { skipped: true, reason: "older_version" };
  }

  await studentRef.set({
    rip: projection,
    estado: projection.statusLabel,
    status: projection.statusLabel,
    statusSource: SOURCE_PROJECT_ID,
    ripSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return { skipped: false };
}

// El HUB decide el acceso con users/{email}: RIP lo gobierna desde aquí.
// Acudientes con VARIOS estudiantes: la cuenta queda habilitada si AL MENOS
// UNO de sus estudiantes vinculados conserva acceso (OR). Un estudiante
// inactivo nunca bloquea la cuenta completa.
async function otherLinkedStudentHasAccess(userData, excludeStudentId) {
  const ids = (Array.isArray(userData.studentIds) ? userData.studentIds : [])
    .map(toText)
    .filter((id) => id && id !== excludeStudentId)
    .slice(0, 10); // límite defensivo de lecturas

  for (const otherId of ids) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await targetDb.collection(TARGET_STUDENTS_COLLECTION).doc(otherId).get();
    if (!snap.exists) continue;
    const rip = (snap.data() || {}).rip;
    if (rip && typeof rip === "object" && rip.canAccessHub === true) return true;
  }
  return false;
}

async function updateLinkedUsers(studentId, projection) {
  const snap = await targetDb
    .collection(TARGET_USERS_COLLECTION)
    .where("studentIds", "array-contains", studentId)
    .limit(50)
    .get();

  let updated = 0;
  for (const userDoc of snap.docs) {
    const data = userDoc.data() || {};
    const role = normalizeText(data.role || data.rol);
    if (role && !STUDENT_ROLES.has(role)) continue;

    let accountEnabled = projection.accountEnabled;
    let canAccessHub = projection.canAccessHub;
    if (!accountEnabled) {
      // eslint-disable-next-line no-await-in-loop
      const someoneElse = await otherLinkedStudentHasAccess(data, studentId);
      if (someoneElse) {
        accountEnabled = true;
        canAccessHub = true;
      }
    }

    // eslint-disable-next-line no-await-in-loop
    await userDoc.ref.set(
      {
        // Campos explícitos de la política central. `active` plano en users
        // == accountEnabled (compatibilidad con reglas y HUB actuales).
        accountEnabled,
        canAccessHub,
        active: accountEnabled,
        studentStatus: projection.statusLabel,
        statusSource: SOURCE_PROJECT_ID,
        statusVersion: projection.statusVersion,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    updated += 1;
  }
  return updated;
}

async function writeSyncStatus(payload) {
  await ripDb.collection(SYNC_META_COLLECTION).doc(SYNC_META_DOC).set(
    {
      ...payload,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

// Solo errores y casos no resueltos generan documento de log propio.
async function logSyncIssue(event, message, context = {}) {
  try {
    await ripDb.collection(SYNC_LOGS_COLLECTION).add({
      event,
      ok: false,
      error: toText(message).slice(0, 1500),
      context,
      source: SOURCE_PROJECT_ID,
      schemaVersion: SCHEMA_VERSION,
      attempt: safeNumber(context.attempt) || 1,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (logError) {
    logger.error("No se pudo escribir sync_logs.", logError);
  }
}

async function syncComputedDoc(docId, computed, options = {}) {
  // Los docs históricos marcados como alias NUNCA publican: su canónico es
  // el único publicador (evita la doble publicación canónico + legado).
  if (toText(computed?.legacyAliasOf)) {
    return { skipped: true, reason: "legacy_alias", docId };
  }

  const resolution = await resolveCanonicalStudentId(docId, computed || {});

  if (!resolution.studentId) {
    logger.warn("studentComputed sin studentId canónico; no se publica.", { docId });
    await logSyncIssue(
      "syncStudentStatus_unresolved",
      "No se pudo resolver el studentId canónico. Ejecutar migración de RIP o revisar manualmente.",
      { docId, estudiante: toText(computed?.estudiante) }
    );
    return { skipped: true, reason: "unresolved", docId };
  }

  // Si este doc NO es el canónico pero el canónico ya existe, se cede la
  // publicación al canónico (segunda barrera contra publicaciones dobles).
  if (resolution.studentId !== docId) {
    const canonicalSnap = await ripDb.collection(COMPUTED_COLLECTION).doc(resolution.studentId).get();
    if (canonicalSnap.exists) {
      return { skipped: true, reason: "canonical_doc_exists", docId, studentId: resolution.studentId };
    }
  }

  return publishStatus(resolution.studentId, computed || {}, {
    resolution: resolution.source,
    eventTimeMillis: options.eventTimeMillis,
  });
}

/* =========================
   Triggers y endpoints
========================= */

exports.syncStudentStatus = onDocumentWritten(
  {
    document: `${COMPUTED_COLLECTION}/{docId}`,
    region: "us-central1",
    timeoutSeconds: 60,
    memory: "256MiB",
    // Reintentos seguros del runtime: la versión determinista y los merges
    // idempotentes garantizan que reintentar no duplica ni retrocede estado.
    retry: true,
  },
  async (event) => {
    if (!event.data || !event.data.after.exists) {
      logger.info("studentComputed eliminado: no se retira el estado publicado automáticamente.", {
        docId: event.params.docId,
      });
      return;
    }

    try {
      const computed = event.data.after.data() || {};
      const result = await syncComputedDoc(event.params.docId, computed, {
        eventTimeMillis: Date.parse(event.time || "") || 0,
      });

      await writeSyncStatus({
        ok: true,
        lastEvent: "syncStudentStatus",
        lastDocId: event.params.docId,
        lastResult: result,
        version: SCHEMA_VERSION,
      });

      logger.info("Estado publicado hacia Bitácoras.", result);
    } catch (error) {
      logger.error("syncStudentStatus falló.", error);
      await logSyncIssue("syncStudentStatus", error.message || error, {
        docId: event.params.docId,
      });
      await writeSyncStatus({
        ok: false,
        lastEvent: "syncStudentStatus",
        lastDocId: event.params.docId,
        lastError: toText(error.message || error),
      });
      throw error;
    }
  }
);

// Proyección independiente para la Lista. Se despliega separada del puente a
// Bitácoras porque cada proyecto puede otorgar permisos en momentos distintos;
// así, una demora administrativa en otro sistema nunca congela la vista de
// inscripciones. Comparte la misma resolución canónica y nunca crea filas.
exports.syncStudentListProjection = onDocumentWritten(
  {
    document: `${COMPUTED_COLLECTION}/{docId}`,
    region: "us-central1",
    timeoutSeconds: 60,
    memory: "256MiB",
    serviceAccount: RUNTIME_SERVICE_ACCOUNT,
    retry: true,
  },
  async (event) => {
    if (!event.data || !event.data.after.exists) return;

    const computed = event.data.after.data() || {};
    const resolution = await resolveCanonicalStudentId(event.params.docId, computed);
    if (!resolution.studentId) {
      logger.info("Lista: studentComputed sin identidad canónica; se conserva sin publicar.", {
        docId: event.params.docId,
        resolution: resolution.source,
      });
      return;
    }

    const version = deriveStatusVersion(computed, Date.parse(event.time || "") || 0);
    const result = await publishListProjection(
      resolution.studentId,
      buildStatusProjection(resolution.studentId, computed, version)
    );
    logger.info("Proyección RIP publicada hacia Lista.", {
      studentId: resolution.studentId,
      resolution: resolution.source,
      result,
    });
  }
);

/*
  Autorización del endpoint administrativo:
  - método POST obligatorio;
  - token SOLO por header `x-sync-token` (comparado con process.env.BACKFILL_TOKEN);
  - cualquier token en query string se RECHAZA aunque sea correcto (los query
    params quedan en logs de acceso; el header no).
*/
function isAuthorizedAdminRequest(req, expectedToken) {
  if (!req || req.method !== "POST") return false;
  const expected = toText(expectedToken);
  if (!expected) return false;
  const queryToken = toText(req.query && req.query.token);
  if (queryToken) return false;
  const provided = toText(typeof req.get === "function" ? req.get("x-sync-token") : "");
  return provided === expected;
}

exports.backfillStudentStatus = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (req, res) => {
    try {
      if (!isAuthorizedAdminRequest(req, process.env.BACKFILL_TOKEN)) {
        res.status(403).json({ ok: false, error: "Backfill no autorizado (POST + header x-sync-token; query string rechazado)." });
        return;
      }

      const maxDocs = Math.max(1, Math.min(Number(req.query.limit || 5000), 10000));
      const pageSize = Math.max(1, Math.min(Number(req.query.pageSize || 300), 500));
      const results = [];
      let lastDoc = null;
      let scanned = 0;

      while (scanned < maxDocs) {
        let pageQuery = ripDb
          .collection(COMPUTED_COLLECTION)
          .orderBy(admin.firestore.FieldPath.documentId())
          .limit(Math.min(pageSize, maxDocs - scanned));

        if (lastDoc) pageQuery = pageQuery.startAfter(lastDoc);

        // eslint-disable-next-line no-await-in-loop
        const snapshot = await pageQuery.get();
        if (snapshot.empty) break;

        for (const doc of snapshot.docs) {
          // eslint-disable-next-line no-await-in-loop
          results.push(await syncComputedDoc(doc.id, doc.data() || {}));
        }

        scanned += snapshot.size;
        lastDoc = snapshot.docs[snapshot.docs.length - 1];
        if (snapshot.size < pageSize) break;
      }

      const summary = {
        ok: true,
        scanned,
        published: results.filter((item) => !item.skipped).length,
        unresolved: results.filter((item) => item.reason === "unresolved").length,
        samples: results.slice(0, 10),
      };

      await writeSyncStatus({
        ...summary,
        lastEvent: "backfillStudentStatus",
      });

      res.json(summary);
    } catch (error) {
      logger.error("backfillStudentStatus falló.", error);
      await logSyncIssue("backfillStudentStatus", error.message || error, {});
      res.status(500).json({ ok: false, error: error.message || String(error) });
    }
  }
);

// Internos expuestos solo para pruebas unitarias (node test/).
exports._internals = {
  derivePermissionsFromStatus,
  statusCodeFromLabel,
  buildStatusProjection,
  deriveStatusVersion,
  looksLikeAutoId,
  normalizeText,
  uniqueTextList,
  isAuthorizedAdminRequest,
};

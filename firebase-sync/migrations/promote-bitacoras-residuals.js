"use strict";

/* =============================================================================
  Promoción de los históricos residuales de Bitácoras a registros primarios
  de la Lista (estudiantes-musicala/estudiantes).

  Uso:
    node promote-bitacoras-residuals.js --dry-run     (por defecto)
    node promote-bitacoras-residuals.js --apply

  DECISIÓN DE DISEÑO CLAVE — por qué el docId es el mismo `stu_<nombre>_<fila>`:

  El historial pedagógico de Bitácoras se lee por ID de documento directo,
  sin resolución por alias:
    - student_private_notes/{studentId}              (doc directo)
    - student_route_progress/{studentId}__{ruta}     (doc directo)
    - student_routes/{studentId}__{proceso}          (doc directo)
    - bitacoras: studentIds[], primaryStudentId y studentOverrides{} usan
      el `stu_` como CLAVE DE MAPA.

  Darles un studentId canónico nuevo obligaría a mover esos documentos y a
  reescribir claves de mapa dentro de miles de bitácoras: invasivo, difícil
  de revertir y con riesgo de dejar a un profesor sin sus observaciones.

  Reutilizar el `stu_` como docId de la Lista lo vuelve canónico por
  definición (el docId de `estudiantes` ES la identidad oficial), y entonces
  TODO el historial sigue resolviendo sin mover un solo documento. El espejo
  que escribe syncStudentIdentity cae sobre el mismo doc de Bitácoras, así
  que mergea en vez de duplicar.

  Criterio de promoción: solo registros con señal real de estudiante
  (correo O bitácoras de clase). Los cascarones vacíos y los artefactos de
  prueba se reportan, nunca se crean ni se borran.
============================================================================= */

const admin = require("firebase-admin");
const {
  parseArgs, getDb, toText, norm, BatchWriter, writeReport,
} = require("./lib/common");
const { buildHistoricalDirectory } = require("../functions/historical-directory");

const LISTA_PROJECT = "estudiantes-musicala";
const BITACORAS_PROJECT = "bitacoras-de-clase";
const COLLECTION = "estudiantes";
const JOBS_COLLECTION = "integration_jobs";
const PROMOTION_TAG = "bitacoras_promotion_2026_07";

function firstText(...values) {
  for (const value of values) {
    const text = toText(value);
    if (text) return text;
  }
  return "";
}

// Artefactos que no son personas: encabezados de la hoja y registros de
// prueba (un solo token, sin historial de clases).
function isJunk(name, logs) {
  const key = norm(name);
  if (!key) return true;
  if (key === "estudiantes" || key === "estudiante") return true;
  if (key.split(" ").filter(Boolean).length < 2 && logs === 0) return true;
  return false;
}

function buildPayload(bit, docId, row) {
  const payload = {
    studentId: docId,
    studentKey: docId,
    schemaVersion: 2,
    identitySource: PROMOTION_TAG,
    promotedFrom: "bitacoras-de-clase/students",
    studentName: firstText(bit.nombre, bit.name, row.studentName),
    normalizedName: norm(firstText(bit.nombre, bit.name, row.studentName)),
  };
  const optional = {
    status: firstText(bit.estado, bit.status, row.status),
    studentEmail: firstText(bit.email, bit.correo, bit.correoElectronico, row.studentEmail),
    age: bit.edad,
    course: firstText(bit.area, bit.curso, bit.programa, row.course),
    instrument: firstText(bit.instrumento, row.instrument),
    modality: firstText(bit.modalidad, row.modality),
    interests: firstText(bit.interesesMusicales, bit.intereses, row.interests),
    guardianName: firstText(bit.acudiente, row.guardianName),
    mobile: firstText(bit.celular, bit.mobile, row.mobile),
    phone: firstText(bit.telefono, bit.phone, row.phone),
    sourceRow: bit.sourceRow,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined && value !== null && toText(value) !== "") payload[key] = value;
  }
  if (Array.isArray(bit.emails) && bit.emails.length) payload.allEmails = bit.emails;
  if (bit.createdAt && typeof bit.createdAt.toDate === "function") {
    payload.createdAt = bit.createdAt;
  } else {
    payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
  }
  return payload;
}

async function main() {
  const { apply, limit } = parseArgs(process.argv);
  const listaDb = getDb(LISTA_PROJECT);
  const bitDb = getDb(BITACORAS_PROJECT);
  const writer = new BatchWriter(listaDb, apply);

  const report = {
    project: LISTA_PROJECT,
    script: "promote-bitacoras-residuals",
    mode: apply ? "apply" : "dry-run",
    startedAt: new Date().toISOString(),
    residualsFound: 0,
    promoted: 0,
    skippedJunk: [],
    skippedEmptyShell: [],
    skippedExisting: [],
    promotedDetails: [],
  };

  const [listaSnap, bitSnap, logsSnap] = await Promise.all([
    listaDb.collection(COLLECTION).get(),
    bitDb.collection("students").get(),
    bitDb.collection("bitacoras").get(),
  ]);

  const listaIds = new Set(listaSnap.docs.map((doc) => doc.id));
  const bitById = new Map(bitSnap.docs.map((doc) => [doc.id, doc.data() || {}]));

  const logCount = new Map();
  for (const doc of logsSnap.docs) {
    const data = doc.data() || {};
    const ids = new Set([
      ...(Array.isArray(data.studentIds) ? data.studentIds : []),
      toText(data.primaryStudentId),
    ].filter(Boolean));
    for (const id of ids) logCount.set(id, (logCount.get(id) || 0) + 1);
  }

  const directory = buildHistoricalDirectory(
    listaSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
    bitSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
  );
  report.residualsFound = directory.students.length;

  let processed = 0;
  for (const row of directory.students) {
    if (limit && processed >= limit) break;
    processed += 1;

    const docId = toText(row.sourceId);
    const bit = bitById.get(docId) || {};
    const name = firstText(bit.nombre, bit.name, row.studentName);
    const logs = logCount.get(docId) || 0;
    const email = firstText(bit.email, bit.correo, bit.correoElectronico, row.studentEmail);

    if (listaIds.has(docId)) {
      report.skippedExisting.push({ docId, name });
      continue;
    }
    if (isJunk(name, logs)) {
      report.skippedJunk.push({ docId, name, logs });
      continue;
    }
    // Señal real de estudiante: correo de contacto o historial de clases.
    if (!email && logs === 0) {
      report.skippedEmptyShell.push({ docId, name });
      continue;
    }

    // El job sembrado como completado impide que
    // processStudentRegistrationSideEffects mande correo de bienvenida
    // o llame al Apps Script legado al crearse el documento.
    await writer.set(listaDb.collection(JOBS_COLLECTION).doc(docId), {
      studentId: docId,
      type: "legacy_registration_side_effects",
      status: "completed",
      sheetSynced: true,
      welcomeEmailSent: true,
      internalNotificationSent: true,
      seededBy: PROMOTION_TAG,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    if (apply) await writer.flush(); // el job debe existir antes que el doc

    await writer.set(listaDb.collection(COLLECTION).doc(docId), buildPayload(bit, docId, row));
    report.promoted += 1;
    report.promotedDetails.push({ docId, name, email: Boolean(email), logs });
  }

  await writer.flush();
  report.finishedAt = new Date().toISOString();
  report.writes = writer.written;
  const file = writeReport("promote-bitacoras-residuals", report);
  console.log(`[${report.mode}] residuales=${report.residualsFound} promovidos=${report.promoted} ` +
    `basura=${report.skippedJunk.length} cascarones=${report.skippedEmptyShell.length} ` +
    `yaExistian=${report.skippedExisting.length}`);
  console.log(`Reporte: ${file}`);
}

main().catch((error) => {
  console.error("La promoción falló:", error);
  process.exitCode = 1;
});

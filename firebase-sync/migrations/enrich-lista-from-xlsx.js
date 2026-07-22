"use strict";

/* =============================================================================
  Enriquecimiento único de Lista (estudiantes-musicala) desde el Excel
  histórico "Estudiantes Musicala 2026" (hoja Inscripción estudiantes),
  exportado a input-estudiantes-2026.json por export_xlsx.py.

  Objetivo: que Firebase quede como única fuente de verdad y se pueda apagar
  el puente Apps Script/Sheets de Bitácoras.

  Uso:
    node enrich-lista-from-xlsx.js --dry-run       (por defecto; no escribe)
    node enrich-lista-from-xlsx.js --apply
    node enrich-lista-from-xlsx.js --dry-run --limit=200

  Qué hace:
  1. Cruza cada fila del Excel contra `estudiantes` usando la escalera
     canónica (studentId → correo único → documento → nombre único).
  2. En coincidencias: COMPLETA solo campos vacíos. Nunca sobreescribe un
     valor existente. No toca status/estado si ya existen (RIP/Lista mandan).
  3. Filas sin coincidencia: crea el estudiante como registro primario
     (identitySource: xlsx_import_2026_07). Antes de crear, siembra
     integration_jobs/{id} como completed para que
     processStudentRegistrationSideEffects NO envíe correos de bienvenida
     ni llame al Apps Script legado.
  4. Dedup interno del Excel por documento y por nombre+fechaNacimiento
     (conserva la fila más completa; las demás se reportan).
  5. `sourceRow` viaja en el doc creado para que syncStudentIdentity marque
     el espejo legado (stu_...) de Bitácoras como alias y no duplique.
============================================================================= */

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const {
  parseArgs, getDb, toText, norm, normalizeEmail, forEachDoc,
  BatchWriter, writeReport, looksLikeAutoId,
} = require("./lib/common");

const PROJECT_ID = "estudiantes-musicala";
const COLLECTION = "estudiantes";
const JOBS_COLLECTION = "integration_jobs";
const INPUT = path.join(__dirname, "input-estudiantes-2026.json");
const IMPORT_TAG = "xlsx_import_2026_07";

// Campos que la migración puede escribir. status solo si el doc no tiene
// ninguno; los campos rip.* jamás se tocan.
const FILLABLE_FIELDS = [
  "studentName", "studentDocument", "birthDate", "age", "studentCity",
  "studentAddress", "studentEmail", "phone", "mobile", "course", "instrument",
  "style", "emphasis", "interests", "selectedPlan", "modality", "eps", "rh",
  "guardianName", "guardianDocument", "guardianMobile", "guardianPhone",
  "guardianAddress", "relationship", "referredName", "referredMobile",
];

// Aliases legados con los que el Formulario viejo guardaba estos campos:
// si el doc ya tiene el dato bajo el alias, NO se duplica bajo la clave nueva.
const FIELD_ALIASES = {
  studentName: ["nombres_y_apellidos_estudiante", "nombres_y_apellidos_estudiante_2"],
  status: ["estado"],
  studentDocument: ["no_de_documento_estudiante"],
  birthDate: ["fecha_de_nacimiento_estudiante"],
  age: ["edad"],
  studentCity: ["localidad_municipio_de_residencia_estudiante"],
  studentAddress: ["direccion_de_residencia_estudiante"],
  studentEmail: ["correo_electronico_envio_de_guias_e_informacion_adicional"],
  phone: ["telefono_fijo"],
  mobile: ["celular"],
  course: ["curso"],
  instrument: ["instrumento"],
  style: ["estilo"],
  emphasis: ["enfasis"],
  interests: [],
  selectedPlan: ["plan_seleccionado"],
  modality: ["modalidad"],
  eps: [],
  rh: [],
  guardianName: ["nombre_completo_acudiente"],
  guardianDocument: ["tipo_y_numero_de_identificacion_acudiente"],
  guardianMobile: ["celular_acudiente"],
  guardianPhone: ["telefono_fijo_acudiente"],
  guardianAddress: ["direccion_acudiente"],
  relationship: ["parentesco"],
  referredName: ["nombre_referido"],
  referredMobile: ["celular_referido"],
  createdAt: ["timestamp", "marca_temporal", "inscripcion", "registration"],
};

function hasValue(doc, field) {
  const keys = [field, ...(FIELD_ALIASES[field] || [])];
  return keys.some((key) => {
    const value = doc[key];
    if (value === undefined || value === null) return false;
    if (typeof value === "string") return value.trim() !== "";
    return true; // números, Timestamps, booleanos cuentan como valor
  });
}

function normDocNumber(value) {
  return norm(value).replace(/[^a-z0-9]/g, "");
}

function completeness(rec) {
  return Object.keys(rec).length;
}

function dedupeRows(rows, report) {
  const byKey = new Map();
  const keyOf = (rec) => {
    const doc = normDocNumber(rec.studentDocument);
    if (doc && doc.length >= 5) return `doc:${doc}`;
    const name = norm(rec.studentName);
    const birth = toText(rec.birthDate);
    if (name && birth) return `nb:${name}|${birth}`;
    return `row:${rec.sourceRow}`;
  };
  for (const rec of rows) {
    const key = keyOf(rec);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, rec);
    } else {
      const keep = completeness(rec) > completeness(prev) ? rec : prev;
      const drop = keep === rec ? prev : rec;
      byKey.set(key, keep);
      report.duplicatesInSheet.push({
        kept: { row: keep.sourceRow, name: keep.studentName },
        dropped: { row: drop.sourceRow, name: drop.studentName },
      });
    }
  }
  return [...byKey.values()];
}

function parseCreatedAt(value) {
  const text = toText(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return admin.firestore.Timestamp.fromDate(date);
}

async function main() {
  const { apply, limit } = parseArgs(process.argv);
  if (!fs.existsSync(INPUT)) {
    throw new Error(`No existe ${INPUT}. Corre primero export_xlsx.py.`);
  }
  const inputRows = JSON.parse(fs.readFileSync(INPUT, "utf8"));
  const db = getDb(PROJECT_ID);
  const writer = new BatchWriter(db, apply);

  const report = {
    project: PROJECT_ID,
    script: "enrich-lista-from-xlsx",
    mode: apply ? "apply" : "dry-run",
    startedAt: new Date().toISOString(),
    inputRows: inputRows.length,
    afterDedupe: 0,
    scannedExisting: 0,
    enriched: 0,
    alreadyComplete: 0,
    created: 0,
    ambiguous: [],
    duplicatesInSheet: [],
    enrichedDetails: [],
    createdDetails: [],
  };

  // Índices de los estudiantes existentes en Lista.
  const existingDocs = [];
  const byId = new Map();
  const byEmail = new Map();
  const byDoc = new Map();
  const byName = new Map();
  const addTo = (map, key, id) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(id);
  };

  await forEachDoc(db, COLLECTION, 300, async (doc) => {
    const data = doc.data() || {};
    report.scannedExisting += 1;
    // Los archivados por la unificación de duplicados no reciben datos ni
    // cuentan para el cruce: su canónico es quien debe quedar completo.
    if (data.identityMergeStatus === "archived_duplicate") return;
    existingDocs.push({ id: doc.id, data });
    byId.set(doc.id, data);
    const emails = [
      data.studentEmail, data.email, data.correo,
      data.correo_electronico_envio_de_guias_e_informacion_adicional,
    ];
    for (const email of emails) addTo(byEmail, normalizeEmail(email), doc.id);
    const docNum = normDocNumber(data.studentDocument || data.no_de_documento_estudiante || data.documento);
    if (docNum && docNum.length >= 5) addTo(byDoc, docNum, doc.id);
    addTo(byName, norm(data.studentName || data.nombres_y_apellidos_estudiante || data.nombre || data.name), doc.id);
  });

  const rows = dedupeRows(inputRows, report);
  report.afterDedupe = rows.length;

  const uniqueOf = (set) => (set && set.size === 1 ? [...set][0] : "");

  let processed = 0;
  for (const rec of rows) {
    if (limit && processed >= limit) break;
    processed += 1;

    // Escalera de coincidencia: studentId → documento → correo → nombre.
    // Un nivel con varios candidatos no aborta: se intenta el siguiente.
    // Solo si NINGÚN nivel resuelve y alguno fue ambiguo, se reporta.
    let matchId = "";
    let matchSource = "";
    const ambiguousLevels = [];
    const declaredId = toText(rec.studentId);
    if (declaredId && byId.has(declaredId)) {
      matchId = declaredId; matchSource = "studentId";
    }
    const docNum = normDocNumber(rec.studentDocument);
    if (!matchId && docNum && docNum.length >= 5) {
      matchId = uniqueOf(byDoc.get(docNum));
      if (matchId) matchSource = "documento";
      else if (byDoc.get(docNum)?.size > 1) ambiguousLevels.push("documento");
    }
    if (!matchId) {
      const emailSet = byEmail.get(normalizeEmail(rec.studentEmail));
      matchId = uniqueOf(emailSet);
      if (matchId) matchSource = "email";
      else if (emailSet && emailSet.size > 1) ambiguousLevels.push("email");
    }
    if (!matchId) {
      const nameSet = byName.get(norm(rec.studentName));
      matchId = uniqueOf(nameSet);
      if (matchId) matchSource = "nombre";
      else if (nameSet && nameSet.size > 1) ambiguousLevels.push("nombre");
    }
    if (!matchId && ambiguousLevels.length) {
      report.ambiguous.push({ row: rec.sourceRow, name: rec.studentName, via: ambiguousLevels.join("+") });
      continue;
    }

    if (matchId) {
      // Enriquecer: solo campos sin valor en el doc existente.
      const existing = byId.get(matchId) || {};
      const patch = {};
      for (const field of FILLABLE_FIELDS) {
        if (rec[field] !== undefined && !hasValue(existing, field)) patch[field] = rec[field];
      }
      if (rec.status !== undefined && !hasValue(existing, "status")) patch.status = rec.status;
      if (!hasValue(existing, "createdAt")) {
        const created = parseCreatedAt(rec.createdAt);
        if (created) patch.createdAt = created;
      }
      if (!Object.keys(patch).length) {
        report.alreadyComplete += 1;
        continue;
      }
      patch.enrichedFromXlsxAt = admin.firestore.FieldValue.serverTimestamp();
      patch.enrichmentSource = IMPORT_TAG;
      await writer.set(db.collection(COLLECTION).doc(matchId), patch);
      report.enriched += 1;
      report.enrichedDetails.push({
        docId: matchId, row: rec.sourceRow, name: rec.studentName,
        via: matchSource, fields: Object.keys(patch).filter((k) => !k.startsWith("enrich")),
      });
      continue;
    }

    // Crear registro primario nuevo (histórico promovido). El studentId de la
    // hoja solo se respeta si tiene forma de ID Firestore: esa columna a veces
    // trae basura (nombres de otras personas).
    const ref = declaredId && looksLikeAutoId(declaredId)
      ? db.collection(COLLECTION).doc(declaredId)
      : db.collection(COLLECTION).doc();
    const payload = { studentId: ref.id, identitySource: IMPORT_TAG, schemaVersion: 2 };
    for (const field of FILLABLE_FIELDS) {
      if (rec[field] !== undefined) payload[field] = rec[field];
    }
    if (rec.status !== undefined) payload.status = rec.status;
    if (rec.contactId !== undefined) payload.contactId = rec.contactId;
    if (rec.sourceRow !== undefined) payload.sourceRow = rec.sourceRow;
    payload.normalizedName = norm(rec.studentName);
    payload.createdAt = parseCreatedAt(rec.createdAt) || admin.firestore.FieldValue.serverTimestamp();
    payload.enrichmentSource = IMPORT_TAG;

    // Sembrar el job ANTES del doc: bloquea correo de bienvenida y puente legado.
    await writer.set(db.collection(JOBS_COLLECTION).doc(ref.id), {
      studentId: ref.id,
      type: "legacy_registration_side_effects",
      status: "completed",
      sheetSynced: true,
      welcomeEmailSent: true,
      internalNotificationSent: true,
      seededBy: IMPORT_TAG,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    if (apply) await writer.flush(); // el job debe existir antes que el doc
    await writer.set(ref, payload, { merge: false });
    report.created += 1;
    report.createdDetails.push({ docId: ref.id, row: rec.sourceRow, name: rec.studentName });
  }

  await writer.flush();
  report.finishedAt = new Date().toISOString();
  report.writes = writer.written;
  const file = writeReport("enrich-lista-from-xlsx", report);
  console.log(`[${report.mode}] existentes=${report.scannedExisting} filas=${report.afterDedupe} ` +
    `enriquecidos=${report.enriched} completos=${report.alreadyComplete} creados=${report.created} ` +
    `ambiguos=${report.ambiguous.length} dupsHoja=${report.duplicatesInSheet.length}`);
  console.log(`Reporte: ${file}`);
}

main().catch((error) => {
  console.error("La migración falló:", error);
  process.exitCode = 1;
});

"use strict";

/* =============================================================================
  Migración de Lista (estudiantes-musicala).

  Uso:
    node migrate-lista.js --dry-run          (por defecto; no escribe nada)
    node migrate-lista.js --apply            (requiere autorización explícita)
    node migrate-lista.js --dry-run --limit=200

  Qué hace:
  1. Recorre `estudiantes` y añade studentId = doc.id donde falte
     (+ normalizedName, schemaVersion=2, identitySource).
  2. Reporta (NO corrige) documentos donde studentId !== doc.id.
  3. Conserva contactId tal cual.
  4. Detecta posibles duplicados por correo y por documento normalizado;
     nombre+fechaNacimiento solo como señal secundaria. NO fusiona nada.
============================================================================= */

const crypto = require("crypto");
const {
  parseArgs, getDb, toText, norm, normalizeEmail,
  forEachDoc, BatchWriter, writeReport, serverTimestamp,
} = require("./lib/common");

const PROJECT_ID = "estudiantes-musicala";
const COLLECTION = "estudiantes";

/*
  Huella temporal SOLO EN MEMORIA para agrupar posibles duplicados en el
  reporte. NUNCA se persiste: la huella oficial es la HMAC-SHA256 con
  DOC_INDEX_SECRET que calcula ensureDocumentFingerprint() en el backend y
  que queda marcada con fingerprintVersion: 2. Persistir este SHA como
  `documentFingerprint` haría que el backend lo creyera definitivo.
*/
function inMemoryDuplicateKey(studentDocument) {
  const clean = norm(studentDocument).replace(/[^a-z0-9]/g, "");
  if (!clean) return "";
  return crypto.createHash("sha256").update(`musicala:doc:${clean}`).digest("hex");
}

async function main() {
  const { apply, dryRun, limit } = parseArgs(process.argv);
  const db = getDb(PROJECT_ID);
  const writer = new BatchWriter(db, apply);

  const report = {
    project: PROJECT_ID,
    script: "migrate-lista",
    mode: apply ? "apply" : "dry-run",
    startedAt: new Date().toISOString(),
    scanned: 0,
    fixedStudentId: 0,
    alreadyOk: 0,
    legacyShaPendingRecompute: 0,
    mismatches: [],
    duplicates: { byEmail: [], byDocument: [], byNameAndBirth: [] },
  };

  const byEmail = new Map();
  const byDocument = new Map();
  const byNameBirth = new Map();
  let processed = 0;

  await forEachDoc(db, COLLECTION, 300, async (doc) => {
    if (limit && processed >= limit) return;
    processed += 1;
    report.scanned += 1;
    const data = doc.data() || {};
    const declared = toText(data.studentId);

    if (declared && declared !== doc.id) {
      // Inconsistencia: se reporta para revisión manual, no se sobrescribe.
      report.mismatches.push({ docId: doc.id, studentId: declared });
    } else if (!declared || !data.normalizedName || data.schemaVersion !== 2) {
      // La migración NUNCA escribe documentFingerprint: eso es exclusivo del
      // backend (HMAC + fingerprintVersion: 2 + índice privado).
      const patch = {
        studentId: doc.id,
        schemaVersion: 2,
        identitySource: PROJECT_ID,
        updatedAt: serverTimestamp(),
      };
      const name = toText(data.studentName || data.nombre || data.name);
      if (name && !toText(data.normalizedName)) patch.normalizedName = norm(name);
      await writer.set(doc.ref, patch);
      report.fixedStudentId += 1;
    } else {
      report.alreadyOk += 1;
    }

    // Docs con un SHA legado guardado como documentFingerprint (sin
    // fingerprintVersion: 2): el backend los recalculará en el backfill.
    if (toText(data.documentFingerprint) && data.fingerprintVersion !== 2) {
      report.legacyShaPendingRecompute += 1;
    }

    // Señales de duplicado (solo reporte; huella en memoria, jamás persistida).
    const email = normalizeEmail(data.studentEmail || data.email || data.correo);
    if (email) {
      if (!byEmail.has(email)) byEmail.set(email, []);
      byEmail.get(email).push(doc.id);
    }
    const fp = inMemoryDuplicateKey(data.studentDocument || data.documento);
    if (fp) {
      if (!byDocument.has(fp)) byDocument.set(fp, []);
      byDocument.get(fp).push(doc.id);
    }
    const nameBirth = `${norm(data.studentName || data.nombre)}|${toText(data.birthDate)}`;
    if (nameBirth !== "|") {
      if (!byNameBirth.has(nameBirth)) byNameBirth.set(nameBirth, []);
      byNameBirth.get(nameBirth).push(doc.id);
    }
  });

  await writer.flush();

  for (const [email, ids] of byEmail) {
    if (ids.length > 1) report.duplicates.byEmail.push({ email, docIds: ids });
  }
  for (const [fp, ids] of byDocument) {
    // El número de documento NUNCA va al reporte; solo la huella.
    if (ids.length > 1) report.duplicates.byDocument.push({ fingerprint: fp.slice(0, 12), docIds: ids });
  }
  for (const [key, ids] of byNameBirth) {
    if (ids.length > 1) {
      report.duplicates.byNameAndBirth.push({ signal: "secundaria", key: key.split("|")[0], docIds: ids });
    }
  }

  report.finishedAt = new Date().toISOString();
  report.writes = writer.written;
  const file = writeReport("migrate-lista", report);
  console.log(`[${report.mode}] scanned=${report.scanned} fixed=${report.fixedStudentId} mismatches=${report.mismatches.length}`);
  console.log(`Duplicados: email=${report.duplicates.byEmail.length} documento=${report.duplicates.byDocument.length}`);
  console.log(`Reporte: ${file}`);
  if (dryRun) console.log("Ninguna escritura realizada (dry-run). Usa --apply con autorización explícita.");
}

main().catch((error) => {
  console.error("Migración de Lista falló:", error);
  process.exitCode = 1;
});

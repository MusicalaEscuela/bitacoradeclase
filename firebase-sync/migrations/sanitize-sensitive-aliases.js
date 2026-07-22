"use strict";

/* =============================================================================
  Saneamiento de aliases sensibles (número de documento).

  Los syncs antiguos replicaron el número de documento como alias en:
    - rip-musicala/students.aliases
    - bitacoras-de-clase/students.studentIds
    - bitacoras-de-clase/users.studentIds (y espejo users.students)
    - bitacoras-de-clase/bitacoras.studentIds (posible)

  Este script los retira conservando el studentId canónico y el resto de
  aliases no sensibles. NUNCA borra información académica ni documentos.

  Uso:
    node sanitize-sensitive-aliases.js --dry-run     (por defecto)
    node sanitize-sensitive-aliases.js --apply       (autorización explícita)
    node sanitize-sensitive-aliases.js --dry-run --limit=200

  Privacidad del reporte: jamás imprime números de documento; solo IDs de
  documentos Firestore afectados y conteos.
============================================================================= */

const {
  parseArgs, getDb, toText, uniqueTexts,
  forEachDoc, BatchWriter, writeReport, serverTimestamp,
} = require("./lib/common");

const LISTA_PROJECT = "estudiantes-musicala";
const RIP_PROJECT = "rip-musicala";
const BITACORAS_PROJECT = "bitacoras-de-clase";

function normalizeAliasValue(value) {
  return toText(value).toUpperCase().replace(/\s+/g, "");
}

function looksLikeDocumentNumber(value) {
  const text = normalizeAliasValue(value);
  return /^(CC|TI|RC|CE|PAS|NIT|PPT)?\d{5,}$/.test(text) || /^(RC|PAS)[A-Z0-9-]{5,}$/.test(text);
}

// Set exacto de documentos reales, leído de la fuente de identidad. Solo se
// usa en memoria: no se escribe ni imprime.
async function loadExactDocumentValues() {
  const db = getDb(LISTA_PROJECT);
  const values = new Set();
  await forEachDoc(db, "estudiantes", 300, async (doc) => {
    const data = doc.data() || {};
    for (const field of [
      data.studentDocument, data.documento, data.identificacion,
      data.numeroDocumento, data.no_de_documento_estudiante,
    ]) {
      const text = normalizeAliasValue(field);
      if (text) {
        values.add(text);
        values.add(text.replace(/^(CC|TI|RC|CE|PAS|NIT|PPT)/, ""));
      }
    }
  });
  values.delete("");
  return values;
}

function splitAliases(values, exactDocs) {
  const kept = [];
  const removed = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = toText(value);
    if (!text) continue;
    const normalized = normalizeAliasValue(text);
    if (exactDocs.has(normalized) || looksLikeDocumentNumber(normalized)) {
      removed.push(text);
    } else {
      kept.push(text);
    }
  }
  return { kept: uniqueTexts(kept), removed };
}

async function sanitizeArrayField(projectLabel, db, writer, collectionName, fieldNames, exactDocs, report, options = {}) {
  const stats = { scanned: 0, updated: 0, blockedEmpty: 0 };
  await forEachDoc(db, collectionName, 300, async (doc) => {
    if (options.limit && stats.scanned >= options.limit) return;
    stats.scanned += 1;
    const data = doc.data() || {};
    const patch = {};
    let removedCount = 0;

    for (const field of fieldNames) {
      const current = data[field];
      if (!Array.isArray(current) || !current.length) continue;
      const { kept, removed } = splitAliases(current, exactDocs);
      if (!removed.length) continue;

      // Nunca dejar un vínculo vacío: si al retirar lo sensible no queda
      // ningún identificador, se reporta para resolución manual.
      if (!kept.length) {
        stats.blockedEmpty += 1;
        report.manualReview.push({
          project: projectLabel,
          collection: collectionName,
          docId: doc.id,
          field,
          reason: "el único identificador es sensible; resolver studentId canónico primero",
        });
        continue;
      }
      patch[field] = kept;
      removedCount += removed.length;
    }

    // Campos escalares que puedan ser un documento (users.studentId legado).
    for (const scalarField of options.scalarFields || []) {
      const value = toText(data[scalarField]);
      if (!value) continue;
      const normalized = normalizeAliasValue(value);
      if (exactDocs.has(normalized) || looksLikeDocumentNumber(normalized)) {
        const fallback = (patch[fieldNames[0]] || data[fieldNames[0]] || [])
          .find((id) => toText(id) && !looksLikeDocumentNumber(id));
        patch[scalarField] = toText(fallback) || "";
        removedCount += 1;
      }
    }

    if (!Object.keys(patch).length) return;
    patch.sanitizedAt = serverTimestamp();
    patch.sanitizedBy = "sanitize-sensitive-aliases";
    await writer.set(doc.ref, patch);
    stats.updated += 1;
    report.removedTotal += removedCount;
  });
  report.collections[`${projectLabel}/${collectionName}`] = stats;
}

async function main() {
  const { apply, dryRun, limit } = parseArgs(process.argv);

  const report = {
    script: "sanitize-sensitive-aliases",
    mode: apply ? "apply" : "dry-run",
    startedAt: new Date().toISOString(),
    removedTotal: 0,
    collections: {},
    manualReview: [],
  };

  const exactDocs = await loadExactDocumentValues();
  report.exactDocumentValuesLoaded = exactDocs.size; // solo el conteo, nunca valores

  const ripDb = getDb(RIP_PROJECT);
  const bitDb = getDb(BITACORAS_PROJECT);
  const ripWriter = new BatchWriter(ripDb, apply);
  const bitWriter = new BatchWriter(bitDb, apply);

  await sanitizeArrayField(RIP_PROJECT, ripDb, ripWriter, "students", ["aliases", "studentIds"], exactDocs, report, { limit });
  await sanitizeArrayField(BITACORAS_PROJECT, bitDb, bitWriter, "students", ["studentIds"], exactDocs, report, { limit });
  await sanitizeArrayField(BITACORAS_PROJECT, bitDb, bitWriter, "users", ["studentIds", "students"], exactDocs, report, {
    limit,
    scalarFields: ["studentId", "studentKey"],
  });
  await sanitizeArrayField(BITACORAS_PROJECT, bitDb, bitWriter, "bitacoras", ["studentIds"], exactDocs, report, { limit });

  await ripWriter.flush();
  await bitWriter.flush();

  report.finishedAt = new Date().toISOString();
  report.writes = ripWriter.written + bitWriter.written;
  report.manualReviewCount = report.manualReview.length;
  const file = writeReport("sanitize-sensitive-aliases", report);
  console.log(`[${report.mode}] aliasesRetirados=${report.removedTotal} docsActualizados=${report.writes} revisionManual=${report.manualReviewCount}`);
  console.log(`Reporte: ${file}`);
  if (dryRun) console.log("Ninguna escritura realizada (dry-run). Usa --apply con autorización explícita.");
}

main().catch((error) => {
  console.error("Saneamiento falló:", toText(error && error.message ? error.message : error));
  process.exitCode = 1;
});

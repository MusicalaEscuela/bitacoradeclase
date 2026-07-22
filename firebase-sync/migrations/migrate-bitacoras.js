"use strict";

/* =============================================================================
  Migración de Bitácoras (bitacoras-de-clase).

  PRERREQUISITO: haber corrido backfillStudentIdentity (Lista → Bitácoras),
  que crea los docs canónicos students/{studentId} con sourceDocId y aliases.

  Uso:
    node migrate-bitacoras.js --dry-run   (por defecto)
    node migrate-bitacoras.js --apply

  Qué hace (idempotente, nunca borra ni fusiona ambiguos):
  1. students: asegura studentId = doc.id en docs canónicos; en docs legados
     resuelve el canónico (sourceDocId del sync anterior o aliases) y los
     marca legacyAliasOf. Construye el mapa alias → canónico.
  2. users: añade el studentId canónico a studentIds conservando los alias.
  3. bitacoras: añade el canónico a studentIds y fija studentId primario
     cuando la bitácora es de un solo estudiante. No quita IDs antiguos.
  4. Reporta resueltos, no resueltos y ambiguos.
============================================================================= */

const {
  parseArgs, getDb, toText, norm, uniqueTexts, looksLikeAutoId,
  forEachDoc, BatchWriter, writeReport, serverTimestamp,
} = require("./lib/common");

const PROJECT_ID = "bitacoras-de-clase";

async function main() {
  const { apply, dryRun, limit } = parseArgs(process.argv);
  const db = getDb(PROJECT_ID);
  const writer = new BatchWriter(db, apply);

  const report = {
    project: PROJECT_ID,
    script: "migrate-bitacoras",
    mode: apply ? "apply" : "dry-run",
    startedAt: new Date().toISOString(),
    collections: {},
    unresolved: [],
    ambiguous: [],
  };

  /* ---- 1. students: índice alias → canónico ---- */
  const aliasToCanonical = new Map(); // alias -> Set(canonicalId)
  const canonicalIds = new Set();
  const legacyStudents = [];

  const addAlias = (alias, canonical) => {
    const safe = toText(alias);
    if (!safe || !canonical) return;
    if (!aliasToCanonical.has(safe)) aliasToCanonical.set(safe, new Set());
    aliasToCanonical.get(safe).add(canonical);
  };

  let studentsScanned = 0;
  let studentsFixed = 0;
  await forEachDoc(db, "students", 300, async (doc) => {
    studentsScanned += 1;
    const data = doc.data() || {};
    const declared = toText(data.studentId);
    const sourceDocId = toText(data.sourceDocId);
    const isCanonical = declared === doc.id || (looksLikeAutoId(doc.id) && !toText(data.legacyAliasOf));

    if (isCanonical) {
      canonicalIds.add(doc.id);
      addAlias(doc.id, doc.id);
      for (const alias of Array.isArray(data.studentIds) ? data.studentIds : []) addAlias(alias, doc.id);
      addAlias(toText(data.studentKey), doc.id);
      addAlias(toText(data.legacyStudentKey), doc.id);
      addAlias(toText(data.contactId), doc.id);
      if (declared !== doc.id) {
        await writer.set(doc.ref, {
          studentId: doc.id,
          schemaVersion: 2,
          migratedAt: serverTimestamp(),
          migratedBy: "migrate-bitacoras",
        });
        studentsFixed += 1;
      }
    } else {
      legacyStudents.push({ id: doc.id, ref: doc.ref, data });
    }
  });

  let legacyLinked = 0;
  for (const legacy of legacyStudents) {
    const data = legacy.data;
    // El sync anterior guardaba sourceDocId = ID del doc en estudiantes-musicala,
    // que ES el studentId canónico.
    let canonical = toText(data.legacyAliasOf) || toText(data.sourceDocId);
    if (!canonical) {
      const viaAlias = aliasToCanonical.get(legacy.id);
      if (viaAlias && viaAlias.size === 1) canonical = [...viaAlias][0];
      else if (viaAlias && viaAlias.size > 1) {
        report.ambiguous.push({ collection: "students", docId: legacy.id, candidates: [...viaAlias] });
        continue;
      }
    }
    if (!canonical) {
      report.unresolved.push({ collection: "students", docId: legacy.id, nombre: toText(data.nombre || data.name) });
      continue;
    }
    canonicalIds.add(canonical);
    addAlias(legacy.id, canonical);
    for (const alias of Array.isArray(data.studentIds) ? data.studentIds : []) addAlias(alias, canonical);
    if (toText(data.legacyAliasOf) !== canonical) {
      await writer.set(legacy.ref, {
        legacyAliasOf: canonical,
        legacyAliasAt: serverTimestamp(),
        legacyAliasSource: "migrate-bitacoras",
      });
      legacyLinked += 1;
    }
  }
  report.collections.students = {
    scanned: studentsScanned,
    canonical: canonicalIds.size,
    fixedStudentId: studentsFixed,
    legacy: legacyStudents.length,
    legacyLinked,
  };

  const resolveAliasSet = (ids) => {
    const canonicals = new Set();
    let ambiguousAlias = "";
    for (const alias of ids) {
      const set = aliasToCanonical.get(toText(alias));
      if (!set) continue;
      if (set.size === 1) canonicals.add([...set][0]);
      else if (set.size > 1) ambiguousAlias = toText(alias);
    }
    return { canonicals: [...canonicals], ambiguousAlias };
  };

  /* ---- 2. users: añadir canónicos a studentIds ---- */
  {
    let scanned = 0;
    let updated = 0;
    await forEachDoc(db, "users", 300, async (doc) => {
      if (limit && scanned >= limit) return;
      scanned += 1;
      const data = doc.data() || {};
      const current = uniqueTexts([
        ...(Array.isArray(data.studentIds) ? data.studentIds : []),
        ...(Array.isArray(data.students) ? data.students : []),
        data.studentId,
        data.studentKey,
      ]);
      if (!current.length) return;
      const { canonicals, ambiguousAlias } = resolveAliasSet(current);
      if (ambiguousAlias) {
        report.ambiguous.push({ collection: "users", docId: doc.id, alias: ambiguousAlias });
      }
      const merged = uniqueTexts([...current, ...canonicals]);
      const primary = canonicals.length === 1 ? canonicals[0] : toText(data.studentId);
      if (merged.length === current.length && primary === toText(data.studentId)) return;
      await writer.set(doc.ref, {
        studentIds: merged,
        ...(canonicals.length === 1 ? { studentId: canonicals[0] } : {}),
        migratedAt: serverTimestamp(),
        migratedBy: "migrate-bitacoras",
      });
      updated += 1;
    });
    report.collections.users = { scanned, updated };
  }

  /* ---- 3. bitacoras: añadir canónicos, fijar studentId primario ---- */
  {
    let scanned = 0;
    let updated = 0;
    let untouched = 0;
    await forEachDoc(db, "bitacoras", 300, async (doc) => {
      if (limit && scanned >= limit) return;
      scanned += 1;
      const data = doc.data() || {};
      const current = uniqueTexts([
        ...(Array.isArray(data.studentIds) ? data.studentIds : []),
        ...(Array.isArray(data.students) ? data.students : []),
        data.studentId,
        data.primaryStudentId,
      ]);
      if (!current.length) { untouched += 1; return; }
      const { canonicals, ambiguousAlias } = resolveAliasSet(current);
      if (ambiguousAlias) {
        report.ambiguous.push({ collection: "bitacoras", docId: doc.id, alias: ambiguousAlias });
      }
      if (!canonicals.length) {
        report.unresolved.push({ collection: "bitacoras", docId: doc.id, studentIds: current.slice(0, 5) });
        return;
      }
      const merged = uniqueTexts([...current, ...canonicals]);
      const patch = {};
      if (merged.length !== current.length) patch.studentIds = merged;
      // Bitácora individual: studentId primario canónico.
      if (canonicals.length === 1 && toText(data.studentId) !== canonicals[0]) {
        patch.studentId = canonicals[0];
        if (toText(data.primaryStudentId) && toText(data.primaryStudentId) !== canonicals[0]) {
          patch.legacyPrimaryStudentId = toText(data.primaryStudentId);
        }
        patch.primaryStudentId = canonicals[0];
      }
      if (!Object.keys(patch).length) { untouched += 1; return; }
      patch.migratedAt = serverTimestamp();
      patch.migratedBy = "migrate-bitacoras";
      await writer.set(doc.ref, patch);
      updated += 1;
    });
    report.collections.bitacoras = { scanned, updated, untouched };
  }

  await writer.flush();

  report.finishedAt = new Date().toISOString();
  report.writes = writer.written;
  report.unresolvedCount = report.unresolved.length;
  report.ambiguousCount = report.ambiguous.length;
  const file = writeReport("migrate-bitacoras", report);
  console.log(`[${report.mode}] students=${JSON.stringify(report.collections.students)}`);
  console.log(`users=${JSON.stringify(report.collections.users)} bitacoras=${JSON.stringify(report.collections.bitacoras)}`);
  console.log(`unresolved=${report.unresolvedCount} ambiguous=${report.ambiguousCount} writes=${report.writes}`);
  console.log(`Reporte: ${file}`);
  if (dryRun) console.log("Ninguna escritura realizada (dry-run). Usa --apply con autorización explícita.");
}

main().catch((error) => {
  console.error("Migración de Bitácoras falló:", error);
  process.exitCode = 1;
});

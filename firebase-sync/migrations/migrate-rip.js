"use strict";

/* =============================================================================
  Migración de RIP (rip-musicala).

  PRERREQUISITO: haber corrido el backfill de identidades Lista → RIP
  (backfillStudentIdentity), que puebla rip-musicala/students con los docs
  canónicos. Esta migración usa ese directorio local; no lee estudiantes-musicala.

  Uso:
    node migrate-rip.js --dry-run     (por defecto)
    node migrate-rip.js --apply

  Qué hace (idempotente, nunca borra):
  1. Construye el índice de identidades desde students (docs canónicos).
  2. students legados (por nombre): anota officialStudentId cuando resuelve.
  3. registro / primeraVez: añade studentId canónico donde falte.
  4. clientesB2C: añade studentId a cada usuario del arreglo.
  5. programacion: crea programacion/{studentId} si no existe y marca el doc
     legado con legacyAliasOf (conserva ambos).
  6. studentComputed: anota canonicalStudentId (lo usa syncStudentStatus) y
     crea studentComputed/{studentId} espejo.
  7. Reporta resueltos, no resueltos y ambiguos. Los ambiguos NUNCA se asignan.

  Resolución: studentId explícito → officialStudentId → correo único →
  documento (huella, si está en aliases) → alias heredado → nombre único.
============================================================================= */

const {
  parseArgs, getDb, toText, norm, uniqueTexts, looksLikeAutoId,
  forEachDoc, BatchWriter, writeReport, serverTimestamp,
  buildIdentityIndex, resolveCanonical,
} = require("./lib/common");

const PROJECT_ID = "rip-musicala";

async function loadIndex(db, report) {
  const entries = [];
  const legacyDocs = [];
  await forEachDoc(db, "students", 300, async (doc) => {
    const data = doc.data() || {};
    const isCanonical =
      (toText(data.studentId) === doc.id && toText(data.identitySource) === "estudiantes-musicala") ||
      looksLikeAutoId(doc.id);
    if (isCanonical) {
      entries.push({
        canonicalId: doc.id,
        name: toText(data.name || data.estudiante),
        nameKey: toText(data.nameKey || data.estudianteKey) || norm(data.name || data.estudiante),
        emails: Array.isArray(data.emails) ? data.emails : (data.email ? [data.email] : []),
        aliases: Array.isArray(data.aliases) ? data.aliases : [],
      });
    } else {
      legacyDocs.push({ id: doc.id, ref: doc.ref, data });
      if (toText(data.officialStudentId)) {
        entries.push({
          canonicalId: toText(data.officialStudentId),
          name: toText(data.name || data.estudiante),
          nameKey: doc.id,
          emails: [],
          aliases: [doc.id],
        });
      }
    }
  });
  report.identityDocs = entries.length;
  report.legacyStudentDocs = legacyDocs.length;
  return { index: buildIdentityIndex(entries), legacyDocs };
}

async function main() {
  const { apply, dryRun, limit } = parseArgs(process.argv);
  const db = getDb(PROJECT_ID);
  const writer = new BatchWriter(db, apply);

  const report = {
    project: PROJECT_ID,
    script: "migrate-rip",
    mode: apply ? "apply" : "dry-run",
    startedAt: new Date().toISOString(),
    resolved: 0,
    unresolved: [],
    ambiguous: [],
    collections: {},
  };

  const { index, legacyDocs } = await loadIndex(db, report);

  const resolveFor = (hints, context) => {
    const result = resolveCanonical(index, hints);
    if (result.ambiguous) {
      report.ambiguous.push({ ...context, candidates: result.candidates });
      return "";
    }
    if (!result.id) {
      report.unresolved.push(context);
      return "";
    }
    report.resolved += 1;
    return result.id;
  };

  // ---- 2. students legados: anotar officialStudentId
  let annotated = 0;
  for (const legacy of legacyDocs) {
    if (toText(legacy.data.officialStudentId)) continue;
    const canonical = resolveFor(
      { name: legacy.data.name || legacy.data.estudiante, aliases: [legacy.id] },
      { collection: "students", docId: legacy.id }
    );
    if (!canonical) continue;
    await writer.set(legacy.ref, {
      officialStudentId: canonical,
      studentId: canonical,
      legacyAliasOf: canonical,
      migratedAt: serverTimestamp(),
      migratedBy: "migrate-rip",
    });
    annotated += 1;
  }
  report.collections.students = { annotated };

  // ---- 3. registro y primeraVez: studentId canónico donde falte
  for (const collectionName of ["registro", "primeraVez"]) {
    let updated = 0;
    let scanned = 0;
    let already = 0;
    await forEachDoc(db, collectionName, 300, async (doc) => {
      if (limit && scanned >= limit) return;
      scanned += 1;
      const data = doc.data() || {};
      if (toText(data.studentId)) { already += 1; return; }
      const canonical = resolveFor(
        {
          name: data.estudiante,
          aliases: [toText(data.estudianteKey)].filter(Boolean),
        },
        { collection: collectionName, docId: doc.id, estudiante: toText(data.estudiante) }
      );
      if (!canonical) return;
      await writer.set(doc.ref, {
        studentId: canonical,
        studentIdSource: "migrate-rip",
        migratedAt: serverTimestamp(),
      });
      updated += 1;
    });
    report.collections[collectionName] = { scanned, updated, already };
  }

  // ---- 4. clientesB2C: studentId por usuario
  {
    let updated = 0;
    let scanned = 0;
    await forEachDoc(db, "clientesB2C", 200, async (doc) => {
      if (limit && scanned >= limit) return;
      scanned += 1;
      const data = doc.data() || {};
      const usuarios = Array.isArray(data.usuarios) ? data.usuarios : [];
      let changed = false;
      const next = usuarios.map((u) => {
        if (!u || toText(u.studentId) || !toText(u.estudiante)) return u;
        const canonical = resolveFor(
          { name: u.estudiante, aliases: [norm(u.estudiante)] },
          { collection: "clientesB2C", docId: doc.id, estudiante: toText(u.estudiante) }
        );
        if (!canonical) return u;
        changed = true;
        return { ...u, studentId: canonical };
      });
      if (!changed) return;
      await writer.set(doc.ref, {
        usuarios: next,
        migratedAt: serverTimestamp(),
        migratedBy: "migrate-rip",
      });
      updated += 1;
    });
    report.collections.clientesB2C = { scanned, updated };
  }

  // ---- 5. programacion: doc canónico espejo + marca legacy
  {
    let mirrored = 0;
    let scanned = 0;
    await forEachDoc(db, "programacion", 200, async (doc) => {
      if (limit && scanned >= limit) return;
      scanned += 1;
      const data = doc.data() || {};
      if (looksLikeAutoId(doc.id) || toText(data.legacyAliasOf)) return;
      const canonical = resolveFor(
        { studentId: data.canonicalStudentId, name: data.estudiante, aliases: [doc.id, toText(data.estudianteKey)].filter(Boolean) },
        { collection: "programacion", docId: doc.id, estudiante: toText(data.estudiante) }
      );
      if (!canonical || canonical === doc.id) return;
      const canonicalRef = db.collection("programacion").doc(canonical);
      const canonicalSnap = await canonicalRef.get();
      if (!canonicalSnap.exists) {
        await writer.set(canonicalRef, {
          ...data,
          studentId: canonical,
          canonicalStudentId: canonical,
          estudianteKey: toText(data.estudianteKey) || doc.id,
          migratedFrom: doc.id,
          migratedAt: serverTimestamp(),
        });
      }
      await writer.set(doc.ref, {
        canonicalStudentId: canonical,
        legacyAliasOf: canonical,
        migratedAt: serverTimestamp(),
      });
      mirrored += 1;
    });
    report.collections.programacion = { scanned, mirrored };
  }

  // ---- 6. studentComputed: canonicalStudentId + espejo canónico
  {
    let annotatedComputed = 0;
    let scanned = 0;
    await forEachDoc(db, "studentComputed", 200, async (doc) => {
      if (limit && scanned >= limit) return;
      scanned += 1;
      const data = doc.data() || {};
      if (toText(data.canonicalStudentId)) return;
      const canonical = resolveFor(
        { name: data.estudiante, aliases: [doc.id, toText(data.estudianteKey)].filter(Boolean) },
        { collection: "studentComputed", docId: doc.id, estudiante: toText(data.estudiante) }
      );
      if (!canonical) return;
      await writer.set(doc.ref, {
        canonicalStudentId: canonical,
        migratedAt: serverTimestamp(),
      });
      if (canonical !== doc.id) {
        const canonicalRef = db.collection("studentComputed").doc(canonical);
        const canonicalSnap = await canonicalRef.get();
        if (!canonicalSnap.exists) {
          await writer.set(canonicalRef, {
            ...data,
            studentId: canonical,
            canonicalStudentId: canonical,
            estudianteKey: toText(data.estudianteKey) || doc.id,
            migratedFrom: doc.id,
            migratedAt: serverTimestamp(),
          });
        }
      }
      annotatedComputed += 1;
    });
    report.collections.studentComputed = { scanned, annotated: annotatedComputed };
  }

  await writer.flush();

  report.finishedAt = new Date().toISOString();
  report.writes = writer.written;
  report.unresolvedCount = report.unresolved.length;
  report.ambiguousCount = report.ambiguous.length;
  // Los detalles pueden ser largos: se truncan en consola, completos en JSON.
  const file = writeReport("migrate-rip", report);
  console.log(`[${report.mode}] resolved=${report.resolved} unresolved=${report.unresolvedCount} ambiguous=${report.ambiguousCount} writes=${report.writes}`);
  console.log(`Reporte: ${file}`);
  if (dryRun) console.log("Ninguna escritura realizada (dry-run). Usa --apply con autorización explícita.");
}

main().catch((error) => {
  console.error("Migración de RIP falló:", error);
  process.exitCode = 1;
});

"use strict";

/* =============================================================================
  Etapa 2 de duplicados: unifica registros duplicados en Lista
  (estudiantes-musicala/estudiantes) replicando la semántica de la función
  mergeStudentDuplicate (canonical + archived_duplicate).

  Uso:
    node merge-lista-duplicates.js --dry-run     (por defecto)
    node merge-lista-duplicates.js --apply

  Reglas:
  - Solo une grupos con EVIDENCIA FUERTE: mismo número de documento
    normalizado (>=5 caracteres). Coincidencias solo por nombre se reportan
    para revisión manual, nunca se unen automáticamente.
  - Canónico del grupo: el doc con más campos con valor; empate → el de
    createdAt más antiguo; empate → ID estable (orden alfabético).
  - Los demás quedan identityMergeStatus: archived_duplicate con
    canonicalStudentId, igual que la función oficial. No se borra nada.
  - Correos de todos se consolidan en alternateEmails/allEmails del canónico.
============================================================================= */

const admin = require("firebase-admin");
const {
  parseArgs, getDb, toText, norm, normalizeEmail, uniqueTexts,
  forEachDoc, BatchWriter, writeReport,
} = require("./lib/common");

const PROJECT_ID = "estudiantes-musicala";
const COLLECTION = "estudiantes";
const MERGED_BY = "merge-lista-duplicates_2026_07";

function normDocNumber(value) {
  const clean = norm(value).replace(/[^a-z0-9]/g, "");
  // Documento real: al menos 5 dígitos (descarta texto de encabezados
  // corruptos como "No. de documento (estudiante)").
  return /\d{5,}/.test(clean) ? clean : "";
}

function collectDocs(data) {
  const values = [
    data.studentDocument, data.no_de_documento_estudiante,
    data.documento, data.identificacion, data.numeroDocumento,
  ];
  return new Set(values.map(normDocNumber).filter(Boolean));
}

function studentNameOf(data) {
  return toText(data.studentName) || toText(data.nombres_y_apellidos_estudiante) ||
    toText(data.nombres_y_apellidos_estudiante_2) || toText(data.nombre) || toText(data.name);
}

function collectEmails(data) {
  const out = new Set();
  const push = (v) => {
    if (Array.isArray(v)) return v.forEach(push);
    const email = normalizeEmail(v);
    if (email && email.includes("@")) out.add(email);
  };
  [data.studentEmail, data.email, data.correo,
    data.correo_electronico_envio_de_guias_e_informacion_adicional,
    data.emails, data.alternateEmails, data.allEmails].forEach(push);
  return [...out];
}

function filledFieldCount(data) {
  return Object.values(data).filter((v) =>
    v !== null && v !== undefined && !(typeof v === "string" && v.trim() === "")
  ).length;
}

function createdAtMs(data) {
  const v = data.createdAt;
  if (v && typeof v.toDate === "function") return v.toDate().getTime();
  const parsed = new Date(toText(v)).getTime();
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

function pickCanonical(entries) {
  const hasName = (e) => (studentNameOf(e.data) ? 0 : 1);
  const isModern = (e) => (e.data.schemaVersion === 2 && toText(e.data.studentId) === e.id ? 0 : 1);
  return [...entries].sort((a, b) =>
    hasName(a) - hasName(b) ||
    isModern(a) - isModern(b) ||
    filledFieldCount(b.data) - filledFieldCount(a.data) ||
    createdAtMs(a.data) - createdAtMs(b.data) ||
    a.id.localeCompare(b.id)
  )[0];
}

async function main() {
  const { apply } = parseArgs(process.argv);
  const db = getDb(PROJECT_ID);
  const writer = new BatchWriter(db, apply);

  const report = {
    project: PROJECT_ID,
    script: "merge-lista-duplicates",
    mode: apply ? "apply" : "dry-run",
    startedAt: new Date().toISOString(),
    scanned: 0,
    alreadyArchived: 0,
    groupsMerged: 0,
    archivedNow: 0,
    mergedGroups: [],
    nameOnlyForManualReview: [],
    sameDocumentDifferentName: [],
  };

  const active = [];
  await forEachDoc(db, COLLECTION, 300, async (doc) => {
    report.scanned += 1;
    const data = doc.data() || {};
    if (data.identityMergeStatus === "archived_duplicate") {
      report.alreadyArchived += 1;
      return;
    }
    active.push({ id: doc.id, data });
  });

  // Agrupar por documento compartido (union-find simple vía mapa doc->grupo).
  const groupByDoc = new Map();
  const groups = new Map(); // groupKey -> Set<entry>
  for (const entry of active) {
    const docs = collectDocs(entry.data);
    if (!docs.size) continue;
    let key = "";
    for (const d of docs) {
      if (groupByDoc.has(d)) { key = groupByDoc.get(d); break; }
    }
    if (!key) key = `g:${entry.id}`;
    for (const d of docs) groupByDoc.set(d, key);
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add(entry);
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  for (const members of groups.values()) {
    if (members.size < 2) continue;
    // Evidencia doble para unir sin humano: mismo documento Y mismo nombre.
    // Nombres distintos con el mismo documento pueden ser hermanos usando el
    // documento del acudiente → revisión manual.
    const nameKeys = new Set([...members].map((m) => norm(studentNameOf(m.data))).filter(Boolean));
    // Variante segura: nombres distintos pero uno contenido en el otro
    // ("Juliana Vargas" ⊂ "Juliana Vargas Carvajal") = misma persona.
    // Hermanos comparten documento pero no el nombre de pila → manual.
    const tokenSets = [...members].map((m) => new Set(norm(studentNameOf(m.data)).split(" ").filter(Boolean)));
    const isSubsetChain = tokenSets.every((a) => tokenSets.every((b) => {
      const [small, big] = a.size <= b.size ? [a, b] : [b, a];
      return small.size >= 2 && [...small].every((t) => big.has(t));
    }));
    if (nameKeys.size !== 1 && !isSubsetChain) {
      report.sameDocumentDifferentName.push({
        names: [...members].map((m) => ({ id: m.id, name: studentNameOf(m.data) })),
      });
      continue;
    }
    const canonical = pickCanonical(members);
    const duplicates = [...members].filter((m) => m !== canonical);
    const allEmails = uniqueTexts([...members].flatMap((m) => collectEmails(m.data)));
    const canonicalEmail = normalizeEmail(canonical.data.studentEmail);

    await writer.set(db.collection(COLLECTION).doc(canonical.id), {
      alternateEmails: allEmails.filter((e) => e !== canonicalEmail),
      allEmails,
      mergedSourceStudentIds: uniqueTexts([
        ...(Array.isArray(canonical.data.mergedSourceStudentIds) ? canonical.data.mergedSourceStudentIds : []),
        ...duplicates.map((d) => d.id),
      ]),
      identityMerge: { status: "canonical", updatedAt: now, updatedBy: MERGED_BY },
      updatedAt: now,
    });
    for (const dup of duplicates) {
      await writer.set(db.collection(COLLECTION).doc(dup.id), {
        identityMergeStatus: "archived_duplicate",
        canonicalStudentId: canonical.id,
        archivedFromDirectory: true,
        archivedAt: now,
        archivedBy: MERGED_BY,
        alternateEmails: allEmails,
        updatedAt: now,
      });
    }
    report.groupsMerged += 1;
    report.archivedNow += duplicates.length;
    report.mergedGroups.push({
      canonical: { id: canonical.id, name: studentNameOf(canonical.data) },
      archived: duplicates.map((d) => ({ id: d.id, name: studentNameOf(d.data) })),
    });
  }

  // Duplicados por nombre SIN documento compartido: solo reporte.
  const byName = new Map();
  for (const entry of active) {
    const key = norm(studentNameOf(entry.data));
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(entry);
  }
  const archivedIds = new Set(report.mergedGroups.flatMap((g) => g.archived.map((a) => a.id)));
  for (const [name, entries] of byName) {
    const remaining = entries.filter((e) => !archivedIds.has(e.id));
    if (remaining.length < 2) continue;
    const docsSets = remaining.map((e) => collectDocs(e.data));
    const distinctDocs = new Set(docsSets.flatMap((s) => [...s]));
    if (distinctDocs.size > 1 && docsSets.every((s) => s.size)) continue; // personas distintas (documentos distintos)
    report.nameOnlyForManualReview.push({ name, ids: remaining.map((e) => e.id) });
  }

  await writer.flush();
  report.finishedAt = new Date().toISOString();
  report.writes = writer.written;
  const file = writeReport("merge-lista-duplicates", report);
  console.log(`[${report.mode}] activos=${active.length} gruposUnidos=${report.groupsMerged} ` +
    `archivados=${report.archivedNow} yaArchivados=${report.alreadyArchived} ` +
    `soloNombre=${report.nameOnlyForManualReview.length} docIgualNombreDistinto=${report.sameDocumentDifferentName.length}`);
  console.log(`Reporte: ${file}`);
}

main().catch((error) => {
  console.error("La unificación falló:", error);
  process.exitCode = 1;
});

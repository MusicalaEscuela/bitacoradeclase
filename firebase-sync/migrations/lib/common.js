"use strict";

/* =============================================================================
  Utilidades compartidas por las migraciones.

  Autenticación: Application Default Credentials (gcloud auth
  application-default login) o GOOGLE_APPLICATION_CREDENTIALS apuntando a una
  clave FUERA del repositorio. Nunca se incluyen claves JSON aquí.

  Todas las migraciones:
  - corren en --dry-run por defecto (ninguna escritura);
  - solo escriben con --apply explícito;
  - son idempotentes: reejecutarlas no duplica ni corrompe datos;
  - nunca borran documentos; los antiguos quedan marcados como legacy;
  - generan un reporte JSON en ./reports/.
============================================================================= */

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  const apply = args.has("--apply");
  const dryRun = !apply;
  if (args.has("--dry-run") && apply) {
    throw new Error("No se puede pasar --dry-run y --apply a la vez.");
  }
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Math.max(1, Number(limitArg.split("=")[1]) || 0) : 0;
  return { apply, dryRun, limit };
}

const apps = new Map();
function getDb(projectId) {
  if (!apps.has(projectId)) {
    apps.set(
      projectId,
      admin.initializeApp({ projectId }, `app-${projectId}`)
    );
  }
  return apps.get(projectId).firestore();
}

function toText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function norm(value) {
  return toText(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeEmail(value) {
  return toText(value).toLowerCase().replace(/\s+/g, "");
}

function uniqueTexts(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(toText).filter(Boolean))].sort();
}

function looksLikeAutoId(value) {
  const text = toText(value);
  return /^[A-Za-z0-9]{18,28}$/.test(text) && /[A-Z]/.test(text);
}

async function forEachDoc(db, collectionName, pageSize, handler) {
  let last = null;
  let scanned = 0;
  for (;;) {
    let q = db
      .collection(collectionName)
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(pageSize);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      await handler(doc);
      scanned += 1;
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < pageSize) break;
  }
  return scanned;
}

class BatchWriter {
  constructor(db, apply, maxOps = 400) {
    this.db = db;
    this.apply = apply;
    this.maxOps = maxOps;
    this.batch = apply ? db.batch() : null;
    this.pending = 0;
    this.written = 0;
  }

  async set(ref, data, options = { merge: true }) {
    this.written += 1;
    if (!this.apply) return;
    this.batch.set(ref, data, options);
    this.pending += 1;
    if (this.pending >= this.maxOps) await this.flush();
  }

  async flush() {
    if (!this.apply || !this.pending) return;
    await this.batch.commit();
    this.batch = this.db.batch();
    this.pending = 0;
  }
}

function writeReport(scriptName, report) {
  const dir = path.join(__dirname, "..", "reports");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${scriptName}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
  return file;
}

function serverTimestamp() {
  return admin.firestore.FieldValue.serverTimestamp();
}

/*
  Índice de identidades canónicas a partir de un listado de docs `students`
  (los replicados por syncStudentIdentity en rip-musicala o bitacoras-de-clase,
  o directamente los docs de estudiantes-musicala/estudiantes).
*/
function buildIdentityIndex(entries) {
  const byCanonicalId = new Map();
  const byEmail = new Map();
  const byNameKey = new Map();
  const byAlias = new Map();

  const addTo = (map, key, id) => {
    const safe = toText(key);
    if (!safe || !id) return;
    if (!map.has(safe)) map.set(safe, new Set());
    map.get(safe).add(id);
  };

  for (const entry of entries) {
    const canonicalId = toText(entry.canonicalId);
    if (!canonicalId) continue;
    byCanonicalId.set(canonicalId, entry);
    addTo(byNameKey, entry.nameKey, canonicalId);
    for (const email of entry.emails || []) addTo(byEmail, normalizeEmail(email), canonicalId);
    for (const alias of entry.aliases || []) addTo(byAlias, alias, canonicalId);
    if (entry.documentFingerprint) addTo(byAlias, entry.documentFingerprint, canonicalId);
  }

  return { byCanonicalId, byEmail, byNameKey, byAlias };
}

function uniqueFrom(set) {
  if (!set || !set.size) return { id: "", candidates: [] };
  const candidates = [...set];
  return candidates.length === 1 ? { id: candidates[0], candidates } : { id: "", candidates };
}

/*
  Resolución canónica (misma escalera que rip.identity.js):
  studentId explícito → officialStudentId → correo único → documento
  (fingerprint, vía aliases) → alias heredado → nombre normalizado (único).
*/
function resolveCanonical(index, hints) {
  const explicit = toText(hints.studentId);
  if (explicit && (index.byCanonicalId.has(explicit) || looksLikeAutoId(explicit))) {
    return { id: explicit, source: "explicit", ambiguous: false, candidates: [] };
  }
  const official = toText(hints.officialStudentId);
  if (official && (index.byCanonicalId.has(official) || looksLikeAutoId(official))) {
    return { id: official, source: "officialStudentId", ambiguous: false, candidates: [] };
  }
  for (const email of (hints.emails || []).map(normalizeEmail).filter(Boolean)) {
    const match = uniqueFrom(index.byEmail.get(email));
    if (match.id) return { id: match.id, source: "email", ambiguous: false, candidates: [] };
    if (match.candidates.length > 1) return { id: "", source: "email", ambiguous: true, candidates: match.candidates };
  }
  for (const alias of (hints.aliases || []).map(toText).filter(Boolean)) {
    const match = uniqueFrom(index.byAlias.get(alias));
    if (match.id) return { id: match.id, source: "alias", ambiguous: false, candidates: [] };
    if (match.candidates.length > 1) return { id: "", source: "alias", ambiguous: true, candidates: match.candidates };
  }
  const nameKey = norm(hints.name || "");
  if (nameKey) {
    const match = uniqueFrom(index.byNameKey.get(nameKey));
    if (match.id) return { id: match.id, source: "nameKey", ambiguous: false, candidates: [] };
    if (match.candidates.length > 1) return { id: "", source: "nameKey", ambiguous: true, candidates: match.candidates };
  }
  return { id: "", source: "unresolved", ambiguous: false, candidates: [] };
}

module.exports = {
  parseArgs,
  getDb,
  toText,
  norm,
  normalizeEmail,
  uniqueTexts,
  looksLikeAutoId,
  forEachDoc,
  BatchWriter,
  writeReport,
  serverTimestamp,
  buildIdentityIndex,
  resolveCanonical,
};

"use strict";

// Migra de forma conservadora clases grupales históricas: sólo agrega aliases
// que ya están explícitamente vinculados en el documento del estudiante.
// Uso: node backfill-group-bitacora-aliases.js --apply

const admin = require("firebase-admin");

const apply = process.argv.includes("--apply");
admin.initializeApp({ projectId: "bitacoras-de-clase" });
const db = admin.firestore();

const asList = (value) => Array.isArray(value) ? value : [];
const clean = (value) => String(value || "").trim();
const isSafeAccessAlias = (value) => {
  const id = clean(value);
  // No propagamos documentos de identidad a un índice nuevo.
  return Boolean(id) && (id.includes("@") || /^stu_/i.test(id));
};

async function main() {
  const [bitacorasSnapshot, studentsSnapshot] = await Promise.all([
    db.collection("bitacoras").get(),
    db.collection("students").get(),
  ]);
  const students = new Map(studentsSnapshot.docs.map((doc) => [doc.id, doc.data()]));
  const updates = [];

  for (const doc of bitacorasSnapshot.docs) {
    const item = doc.data();
    const refs = asList(item.studentRefs);
    const ids = asList(item.studentIds).map(clean).filter(Boolean);
    const isGroup = item.mode === "group" || refs.length > 1;
    if (!isGroup || !ids.length) continue;

    const additions = new Set();
    const overrides = { ...(item.studentOverrides || {}) };
    let changedOverrides = false;

    for (const id of ids) {
      const student = students.get(id);
      if (!student) continue;
      const aliases = [student.canonicalStudentId, student.studentId, student.studentKey, ...asList(student.linkedStudentIds)]
        .map(clean)
        .filter(isSafeAccessAlias);
      const sourceOverride = overrides[id] || {};
      for (const alias of aliases) {
        if (!ids.includes(alias)) additions.add(alias);
        if (sourceOverride.processKey && !overrides[alias]) {
          overrides[alias] = { ...sourceOverride };
          changedOverrides = true;
        }
      }
    }

    if (additions.size || changedOverrides) {
      updates.push({
        ref: doc.ref,
        payload: {
          studentIds: [...new Set([...ids, ...additions])],
          linkedStudentIds: [...new Set([...asList(item.linkedStudentIds), ...additions])],
          ...(changedOverrides ? { studentOverrides: overrides } : {}),
        },
      });
    }
  }

  console.log(`${apply ? "Aplicando" : "Vista previa de"} ${updates.length} bitácoras grupales.`);
  if (!apply) return;
  for (let index = 0; index < updates.length; index += 400) {
    const batch = db.batch();
    updates.slice(index, index + 400).forEach(({ ref, payload }) => batch.update(ref, payload));
    await batch.commit();
  }
  console.log(`Sincronizadas ${updates.length} bitácoras grupales.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

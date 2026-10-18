"use strict";
const { createHash } = require('node:crypto');
const key = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const token = value => createHash('sha256').update(key(value)).digest('hex');
const list = value => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;\n]+/) : [])
  .map(v => String(v || '').trim()).filter(Boolean);

function extractWorks(record = {}, ids = []) {
  const content = String(record.content || record.contenido || '');
  const section = content.match(/(?:^|\n)\s*COMPONENTE\s+(?:DE\s+)?OBRAS\s*:[ \t]*([\s\S]*?)(?=\n\s*(?:DOCENTE|TAREAS\s*\/\s*OBSERVACIONES|COMPONENTE[^:\n]*)\s*:|$)/i);
  const works = [...list(record.componenteObras), ...list(section?.[1])];
  for (const id of ids) {
    const override = record.studentOverrides?.[id];
    if (override?.enabled === true) works.push(...list(override.componenteObras));
  }
  return [...new Map(works.filter(name => name.length <= 300 && key(name)).map(name => [key(name), name])).values()];
}

function existingItems(data = {}) {
  const source = data.repertorioProceso || data.repertoireProgress || data.repertorioEscogido || data.repertoire || [];
  return (Array.isArray(source) ? source : []).map(item => typeof item === 'string'
    ? {nombre:item,estado:'proceso',prioridad:'media',notas:'',fechaInicio:'',fechaLogro:''}
    : item).filter(item => item && typeof item.nombre === 'string');
}

function mergeRepertoire(records, works, seen = [], date = '') {
  const items = [], names = new Set(), processed = new Set(seen), pending = [];
  for (const record of records) for (const item of existingItems(record)) {
    if (!names.has(key(item.nombre))) { names.add(key(item.nombre)); items.push(item); }
  }
  for (const name of works) {
    const id = token(name);
    if (processed.has(id)) continue;
    if (names.has(key(name))) { processed.add(id); continue; }
    if (items.length >= 20) { pending.push(name); continue; }
    items.push({ nombre:name, estado:'proceso', prioridad:'media', notas:'',
      fechaInicio:/^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '', fechaLogro:'' });
    names.add(key(name)); processed.add(id);
  }
  return { items, seen:[...processed], pending };
}

function teacherVisible(data = {}) {
  if (typeof data.rip?.showInTeacherLists === 'boolean') return data.rip.showInTeacherLists;
  if (typeof data.showInTeacherLists === 'boolean') return data.showInTeacherLists;
  const status = String(data.rip?.statusLabel || data.estado || data.status || data.estadoActual || data.studentStatus || '').toLowerCase();
  return status === 'activo' || /^activo (?:no registro|en pausa)/.test(status) || /^inactivo en pausa \(1(?:-|–| a )3 meses\)/.test(status);
}

async function syncFromBitacoras(db, FieldValue, { bitacoraIds, studentId = '', isAdmin = false }) {
  const results = new Map(), warnings = [];
  for (const id of bitacoraIds) {
    const snapshot = await db.collection('bitacoras').doc(id).get();
    if (!snapshot.exists) continue;
    const record = snapshot.data();
    const participants = [...new Set([...(record.studentIds || []), record.studentId, record.primaryStudentId].filter(Boolean))];
    for (const participantId of studentId ? [studentId] : participants) {
      const result = await db.runTransaction(async tx => {
        const sourceRef = db.collection('students').doc(participantId);
        const source = await tx.get(sourceRef);
        if (!source.exists) return null;
        const canonicalId = source.data().canonicalStudentId || participantId;
        const canonicalRef = db.collection('students').doc(canonicalId);
        const canonical = canonicalId === participantId ? source : await tx.get(canonicalRef);
        if (!canonical.exists) return null;
        const link = await tx.get(db.collection('student_identity_links').doc(canonicalId));
        const academicId = link.exists && link.data().status === 'confirmed' && link.data().canonicalStudentId === canonicalId
          ? link.data().academicRecordId : '';
        const refs = new Map([[canonicalId, {ref:canonicalRef,snap:canonical}], [participantId,{ref:sourceRef,snap:source}]]);
        if (academicId && !refs.has(academicId)) {
          const ref = db.collection('students').doc(academicId), snap = await tx.get(ref);
          if (snap.exists && snap.data().canonicalStudentId === canonicalId) refs.set(academicId,{ref,snap});
        }
        const ids = [...refs.keys()];
        if (!participants.some(p => ids.includes(p))) return null;
        if (!isAdmin && !teacherVisible(canonical.data())) return {warning:'Hay estudiantes no habilitados para edición docente; su repertorio no se modificó.'};
        const works = extractWorks(record, ids);
        if (!works.length) return null;
        const ledgerRef = db.collection('bitacora_repertoire_sync').doc(canonicalId);
        const ledger = await tx.get(ledgerRef);
        const oldSeen = ledger.exists ? ledger.data().seen || [] : [];
        const merged = mergeRepertoire([...refs.values()].map(v=>v.snap.data()),works,oldSeen,record.fechaClase);
        const names = merged.items.map(item=>item.nombre);
        const payload = {repertorioProceso:merged.items,repertoireProgress:merged.items,repertorioEscogido:names,repertoire:names};
        const updated = [];
        for (const [studentId, {ref,snap}] of refs) {
          const data = snap.data();
          if (Object.keys(payload).some(field=>JSON.stringify(data[field])!==JSON.stringify(payload[field]))) {
            tx.update(ref,{...payload,updatedBy:'profile_repertoire',updatedAt:FieldValue.serverTimestamp()});
            updated.push({id:studentId,...payload});
          }
        }
        if (JSON.stringify(oldSeen)!==JSON.stringify(merged.seen)) {
          tx.set(ledgerRef,{seen:merged.seen,updatedAt:FieldValue.serverTimestamp()},{merge:true});
        }
        return {updated,warning:merged.pending.length ? 'El repertorio alcanzó el máximo de 20 canciones. Las obras adicionales se conservan en la bitácora.' : ''};
      });
      for (const updated of result?.updated || []) results.set(updated.id,updated);
      if (result?.warning) warnings.push(result.warning);
    }
  }
  return {students:[...results.values()],warnings:[...new Set(warnings)]};
}
module.exports = { extractWorks, mergeRepertoire, teacherVisible, syncFromBitacoras };

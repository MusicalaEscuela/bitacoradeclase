"use strict";

/*
  Directorio histórico de solo lectura para Lista de Estudiantes.

  La fuente canónica sigue siendo estudiantes-musicala/estudiantes. Este
  módulo solo completa la visualización con identidades que ya existen en
  bitacoras-de-clase/students (la misma colección consumida por HUB).

  No produce escrituras y nunca devuelve documentos completos: selecciona un
  conjunto pequeño de campos de contacto/académicos y descarta valores
  anormalmente largos para que una celda histórica corrupta no vuelva a
  contaminar la interfaz.
*/

const ACADEMIC_FIELDS = Object.freeze([
  "processes", "area", "programa", "instrumento", "docente", "teacher",
  "modalidad", "modality", "intereses", "interesesMusicales",
]);

function toText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function safeText(value, maxLength = 500) {
  const text = toText(value);
  return text && text.length <= maxLength ? text : "";
}

function normalizeText(value) {
  return toText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeEmail(value) {
  return toText(value).toLowerCase().replace(/\s+/g, "");
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(toText).filter(Boolean))];
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function documentId(record) {
  return toText(record && (record.__documentId || record.id));
}

function studentName(record) {
  return safeText(
    record && (
      record.studentName || record.displayName || record.nombre || record.name ||
      record.estudiante || record.nombreCompleto || record.fullName ||
      record.nombres_y_apellidos_estudiante ||
      record.nombres_y_apellidos_estudiante_2
    ),
    200
  );
}

function recordEmails(record) {
  const values = [
    record && record.emailNormalized,
    record && record.email,
    record && record.correo,
    record && record.correoElectronico,
    record && record.mail,
    record && record.studentEmail,
    record && record.emailEstudiante,
    record && record.correoEstudiante,
    record && record.emailAcudiente,
    record && record.correoAcudiente,
    record && record.acudienteEmail,
    record && record.correo_electronico_envio_de_guias_e_informacion_adicional,
    ...asArray(record && record.emails),
    ...asArray(record && record.correos),
  ];
  const matches = values
    .flatMap((value) => toText(value).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])
    .map(normalizeEmail)
    .filter(Boolean);
  return unique(matches);
}

function nameKey(record) {
  return normalizeText(studentName(record));
}

function emailKey(record) {
  return recordEmails(record)[0] || "";
}

function documentKey(record) {
  return normalizeText(record && record.documentFingerprint).replace(/[^a-z0-9]/g, "");
}

function isLegacyId(value) {
  return /^stu_/i.test(toText(value));
}

function meaningful(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return Boolean(toText(value));
}

function academicScore(record) {
  return ACADEMIC_FIELDS.reduce((score, field) => {
    const value = record && record[field];
    if (Array.isArray(value)) return score + value.length * 3;
    return score + (meaningful(value) ? 1 : 0);
  }, Number(record && record.bitacoraReferenceCount || 0) * 100);
}

function canonicalScore(record) {
  const id = documentId(record);
  let score = isLegacyId(id) ? 0 : 10;
  if (safeText(record && record.identitySource, 100) === "estudiantes-musicala") score += 30;
  if (toText(record && record.studentId) === id) score += 15;
  if (isPlainObject(record && record.rip)) score += 10;
  return score;
}

function createUnionFind(ids) {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id) => {
    let root = parent.get(id);
    while (root && root !== parent.get(root)) {
      parent.set(root, parent.get(parent.get(root)));
      root = parent.get(root);
    }
    if (root) parent.set(id, root);
    return root;
  };
  const union = (left, right) => {
    if (!parent.has(left) || !parent.has(right)) return;
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot && rightRoot && leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  return { find, union };
}

function groupBy(records, getKey) {
  const groups = new Map();
  for (const record of records) {
    const key = getKey(record);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return groups;
}

function buildLogical(group, evidence = []) {
  const canonical = [...group].sort((a, b) => canonicalScore(b) - canonicalScore(a))[0];
  const academic = [...group].sort((a, b) => academicScore(b) - academicScore(a))[0] || canonical;
  const merged = { ...academic, ...canonical };
  for (const field of ACADEMIC_FIELDS) {
    if (meaningful(academic && academic[field])) merged[field] = academic[field];
  }
  const id = documentId(canonical);
  return {
    ...merged,
    id,
    __documentId: id,
    studentId: id,
    canonicalStudentId: id,
    linkedStudentIds: unique(group.map(documentId)),
    identityResolutionStatus: group.length > 1 ? "resolved" : "single",
    identityResolutionEvidence: unique(evidence),
  };
}

function buildPending(group) {
  const representative = [...group].sort((a, b) =>
    academicScore(b) - academicScore(a) || canonicalScore(b) - canonicalScore(a)
  )[0] || group[0];
  const id = documentId(representative);
  return {
    ...representative,
    id,
    __documentId: id,
    studentId: id,
    canonicalStudentId: id,
    linkedStudentIds: id ? [id] : [],
    identityResolutionStatus: "pending",
  };
}

function resolveLogicalStudents(records = []) {
  const items = records
    .filter(Boolean)
    .map((record) => ({ ...record, __documentId: documentId(record) }))
    .filter((record) => documentId(record) && studentName(record));
  const byId = new Map(items.map((record) => [documentId(record), record]));
  const { find, union } = createUnionFind([...byId.keys()]);
  const evidence = new Map();

  const link = (left, right, reason) => {
    if (!byId.has(left) || !byId.has(right) || left === right) return;
    const pair = [left, right].sort().join("|");
    if (!evidence.has(pair)) evidence.set(pair, new Set());
    evidence.get(pair).add(reason);
    union(left, right);
  };

  for (const record of items) {
    const id = documentId(record);
    for (const field of ["canonicalStudentId", "legacyAliasOf"]) {
      link(id, toText(record[field]), field);
    }
    for (const field of ["aliases", "linkedStudentIds"]) {
      for (const target of asArray(record[field])) link(id, toText(target), field);
    }
    for (const targetValue of asArray(record.studentIds)) {
      const target = byId.get(toText(targetValue));
      if (!target) continue;
      const sameDocument = documentKey(record) && documentKey(record) === documentKey(target);
      const sameEmailAndName = emailKey(record) && emailKey(record) === emailKey(target) &&
        nameKey(record) && nameKey(record) === nameKey(target);
      if (sameDocument || sameEmailAndName) {
        link(id, documentId(target), sameDocument ? "studentIds_document" : "studentIds_email");
      }
    }
  }

  for (const group of groupBy(items, documentKey).values()) {
    for (let index = 1; index < group.length; index += 1) {
      link(documentId(group[0]), documentId(group[index]), "documentFingerprint");
    }
  }

  const pendingGroups = [];
  for (const emailGroup of groupBy(items, emailKey).values()) {
    for (const sameIdentity of groupBy(emailGroup, nameKey).values()) {
      const legacy = sameIdentity.filter((record) => isLegacyId(documentId(record)));
      const canonical = sameIdentity.filter((record) => !isLegacyId(documentId(record)));
      if (!legacy.length || !canonical.length) continue;
      if (canonical.length === 1) {
        for (const record of sameIdentity) {
          link(documentId(canonical[0]), documentId(record), "emailNormalized");
        }
      } else {
        pendingGroups.push(sameIdentity);
      }
    }
  }

  const groups = new Map();
  for (const record of items) {
    const root = find(documentId(record));
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(record);
  }

  const pendingIds = new Set(pendingGroups.flatMap((group) => group.map(documentId)));
  const resolved = [...groups.values()]
    .filter((group) => !group.some((record) => pendingIds.has(documentId(record))))
    .map((group) => {
      const reasons = new Set();
      for (let left = 0; left < group.length; left += 1) {
        for (let right = left + 1; right < group.length; right += 1) {
          const pair = [documentId(group[left]), documentId(group[right])].sort().join("|");
          for (const reason of evidence.get(pair) || []) reasons.add(reason);
        }
      }
      return buildLogical(group, [...reasons]);
    });

  return [...resolved, ...pendingGroups.map(buildPending)];
}

function countKeys(records, keyGetter) {
  const counts = new Map();
  for (const record of records) {
    for (const key of keyGetter(record)) {
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

function identityIds(record) {
  return unique([
    documentId(record), record && record.studentId, record && record.officialStudentId,
    record && record.canonicalStudentId, record && record.sourceDocId,
    ...asArray(record && record.studentIds),
    ...asArray(record && record.linkedStudentIds),
  ]);
}

function formatDate(value) {
  if (!value) return "";
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return safeText(value, 80);
}

function firstProcess(record) {
  const process = asArray(record && record.processes)[0] || {};
  return {
    course: safeText(record && (record.course || record.curso || record.area || record.arte || process.area || process.arte), 160),
    instrument: safeText(record && (record.instrument || record.instrumento || record.detalle || process.instrumento || process.detalle), 200),
  };
}

function historicalRow(record, sameNameCount) {
  const id = documentId(record);
  const process = firstProcess(record);
  const rip = isPlainObject(record && record.rip) ? record.rip : {};
  const pending = record.identityResolutionStatus === "pending" || sameNameCount > 1;
  return {
    id: `historical:${id}`,
    sourceId: id,
    studentName: studentName(record),
    status: safeText(rip.statusLabel || record.statusLabel || record.estado || record.status || record.estadoActual, 160),
    birthDate: formatDate(record.birthDate || record.fechaNacimiento || record.fecha_de_nacimiento_estudiante),
    studentEmail: recordEmails(record)[0] || "",
    phone: safeText(record.phone || record.telefono || record.telefonoFijo, 80),
    mobile: safeText(record.mobile || record.celular || record.telefonoMovil, 80),
    course: process.course,
    instrument: process.instrument,
    modality: safeText(record.modality || record.modalidad, 120),
    interests: safeText(record.interests || record.intereses || record.interesesMusicales, 500),
    guardianName: safeText(record.guardianName || record.acudiente || record.nombreAcudiente, 200),
    guardianMobile: safeText(record.guardianMobile || record.celularAcudiente, 80),
    createdAt: formatDate(record.createdAt || record.fechaInscripcion || record.inscripcion),
    recordOrigin: pending
      ? "Histórico consolidado · revisión de identidad · solo lectura"
      : "Histórico consolidado (Bitácoras/HUB) · solo lectura",
    identityResolutionStatus: pending ? "pending" : record.identityResolutionStatus || "single",
    _recordOrigin: "historical",
    _readOnly: true,
  };
}

function buildHistoricalDirectory(sourceRecords = [], bitacorasRecords = []) {
  const logical = resolveLogicalStudents(bitacorasRecords);
  const sourceIds = new Set(sourceRecords.flatMap(identityIds));
  const sourceNameCounts = countKeys(sourceRecords, (record) => [nameKey(record)].filter(Boolean));
  const logicalNameCounts = countKeys(logical, (record) => [nameKey(record)].filter(Boolean));
  const sourceEmailCounts = countKeys(sourceRecords, recordEmails);
  const logicalEmailCounts = countKeys(logical, recordEmails);

  const missing = logical.filter((record) => {
    if (identityIds(record).some((id) => sourceIds.has(id))) return false;
    if (recordEmails(record).some((email) =>
      sourceEmailCounts.get(email) === 1 && logicalEmailCounts.get(email) === 1
    )) return false;
    const key = nameKey(record);
    if (key && sourceNameCounts.get(key) === 1 && logicalNameCounts.get(key) === 1) return false;
    return Boolean(key);
  });

  const missingNameCounts = countKeys(missing, (record) => [nameKey(record)].filter(Boolean));
  const students = missing
    .map((record) => historicalRow(record, missingNameCounts.get(nameKey(record)) || 0))
    .sort((a, b) => normalizeText(a.studentName).localeCompare(normalizeText(b.studentName), "es"));

  return {
    students,
    counts: {
      sourceDocuments: sourceRecords.length,
      bitacorasDocuments: bitacorasRecords.length,
      logicalBitacorasStudents: logical.length,
      historicalStudents: students.length,
      pendingIdentityReview: students.filter((student) => student.identityResolutionStatus === "pending").length,
    },
  };
}

module.exports = {
  buildHistoricalDirectory,
  normalizeText,
  resolveLogicalStudents,
  studentName,
};

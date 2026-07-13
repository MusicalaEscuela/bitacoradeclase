import {
  isPlainObject,
  normalizeText,
  toStringSafe,
  uniqueStrings,
} from "./shared.js";

const ACADEMIC_FIELDS = Object.freeze([
  "processes",
  "area",
  "programa",
  "instrumento",
  "docente",
  "teacher",
  "modalidad",
  "modality",
  "intereses",
  "interesesMusicales",
  "repertoire",
  "repertorioEscogido",
  "repertorioProceso",
  "repertoireProgress",
  "historial",
  "history",
]);

const EXPLICIT_SINGLE_LINK_FIELDS = Object.freeze([
  "canonicalStudentId",
  "legacyAliasOf",
]);

const EXPLICIT_ARRAY_LINK_FIELDS = Object.freeze([
  "aliases",
  "linkedStudentIds",
]);

function normalizeEmail(value) {
  return toStringSafe(value).trim().toLowerCase().replace(/\s+/g, "");
}

function normalizeDocument(value) {
  return toStringSafe(value).replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function getDocumentId(record = {}) {
  return toStringSafe(record.__documentId || record.id);
}

function isStuId(value) {
  return /^stu_/i.test(toStringSafe(value));
}

function hasMeaningfulValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return Boolean(toStringSafe(value));
}

function academicScore(item) {
  const data = item?.data || {};
  let score = Number(data.bitacoraReferenceCount || 0) * 100;

  ACADEMIC_FIELDS.forEach((field) => {
    const value = data[field];
    if (Array.isArray(value)) {
      score += value.length * 3;
    } else if (hasMeaningfulValue(value)) {
      score += 1;
    }
  });

  return score;
}

function canonicalScore(item) {
  const data = item?.data || {};
  let score = isStuId(item?.id) ? 0 : 10;
  if (toStringSafe(data.identitySource) === "estudiantes-musicala") score += 30;
  if (toStringSafe(data.studentId) === item?.id) score += 15;
  if (isPlainObject(data.rip)) score += 10;
  if (normalizeEmail(data.emailNormalized || data.email || data.correo)) score += 2;
  if (
    normalizeDocument(
      data.documentFingerprint ||
        data.documento ||
        data.numeroDocumento ||
        data.identificacion ||
        data.cc
    )
  ) {
    score += 2;
  }
  return score;
}

function createItem(record = {}) {
  const data = isPlainObject(record) ? record : {};
  const id = getDocumentId(data);

  return {
    id,
    data,
    isStu: isStuId(id),
    nameKey: normalizeText(data.nombre || data.name || data.estudiante),
    emailKey: normalizeEmail(
      data.emailNormalized ||
        data.email ||
        data.correo ||
        data.correoElectronico ||
        data.mail
    ),
    documentKey: normalizeDocument(
      data.documentFingerprint ||
        data.documento ||
        data.numeroDocumento ||
        data.identificacion ||
        data.cc
    ),
  };
}

function createDisjointSet(ids = []) {
  const parent = new Map(ids.map((id) => [id, id]));
  const rank = new Map(ids.map((id) => [id, 0]));

  const find = (id) => {
    let root = parent.get(id);
    while (root !== parent.get(root)) {
      parent.set(root, parent.get(parent.get(root)));
      root = parent.get(root);
    }
    parent.set(id, root);
    return root;
  };

  const union = (left, right) => {
    if (!parent.has(left) || !parent.has(right) || left === right) return;
    let leftRoot = find(left);
    let rightRoot = find(right);
    if (leftRoot === rightRoot) return;

    if (rank.get(leftRoot) < rank.get(rightRoot)) {
      [leftRoot, rightRoot] = [rightRoot, leftRoot];
    }

    parent.set(rightRoot, leftRoot);
    if (rank.get(leftRoot) === rank.get(rightRoot)) {
      rank.set(leftRoot, rank.get(leftRoot) + 1);
    }
  };

  return { find, union };
}

function groupBy(items = [], getKey) {
  const groups = new Map();
  items.forEach((item) => {
    const key = getKey(item);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  return groups;
}

function buildLogicalStudent(group = [], evidence = []) {
  const canonical =
    [...group].sort((left, right) => canonicalScore(right) - canonicalScore(left))[0] ||
    group[0];
  const academicCandidates = [...group].sort((left, right) => {
    const scoreDelta = academicScore(right) - academicScore(left);
    if (scoreDelta) return scoreDelta;
    if (left.isStu !== right.isStu) return right.isStu ? 1 : -1;
    return left.id.localeCompare(right.id);
  });
  const bestAcademic = academicCandidates[0] || canonical;
  const academic =
    academicScore(bestAcademic) > academicScore(canonical) ? bestAcademic : canonical;

  const merged = {
    ...(academic?.data || {}),
    ...(canonical?.data || {}),
  };

  ACADEMIC_FIELDS.forEach((field) => {
    const value = academic?.data?.[field];
    if (hasMeaningfulValue(value)) merged[field] = value;
  });

  const linkedStudentIds = uniqueStrings(group.map((item) => item.id));
  const canonicalStudentId = canonical?.id || linkedStudentIds[0] || "";
  const academicRecordId = academic?.id || canonicalStudentId;

  return {
    ...merged,
    id: canonicalStudentId,
    studentId: canonicalStudentId,
    studentKey: canonicalStudentId,
    canonicalStudentId,
    academicRecordId,
    linkedStudentIds,
    identityDocumentId: canonicalStudentId,
    identityDocument: canonical?.data || {},
    academicDocument: academic?.data || {},
    identityResolutionStatus: linkedStudentIds.length > 1 ? "resolved" : "single",
    identityResolutionEvidence: uniqueStrings(evidence),
  };
}

function buildPendingStudent(items = []) {
  const representative =
    [...items].sort((left, right) => {
      const academicDelta = academicScore(right) - academicScore(left);
      if (academicDelta) return academicDelta;
      return canonicalScore(right) - canonicalScore(left);
    })[0] || items[0];
  const id = representative?.id || "";

  return {
    ...(representative?.data || {}),
    id,
    studentId: id,
    studentKey: id,
    canonicalStudentId: id,
    academicRecordId: id,
    linkedStudentIds: id ? [id] : [],
    identityDocumentId: id,
    identityDocument: representative?.data || {},
    academicDocument: representative?.data || {},
    identityResolutionStatus: "pending",
    identityResolutionLabel: "Revisión de identidad pendiente",
    identityResolutionCandidateCount: items.length,
    identityResolutionEvidence: ["email_normalized_with_conflicting_candidates"],
  };
}

export function resolveLogicalStudents(records = []) {
  const items = records.map(createItem).filter((item) => item.id);
  const byId = new Map(items.map((item) => [item.id, item]));
  const { find, union } = createDisjointSet([...byId.keys()]);
  const evidenceByPair = new Map();

  const link = (left, right, evidence) => {
    if (!byId.has(left) || !byId.has(right) || left === right) return;
    const pairKey = [left, right].sort().join("|");
    if (!evidenceByPair.has(pairKey)) evidenceByPair.set(pairKey, new Set());
    evidenceByPair.get(pairKey).add(evidence);
    union(left, right);
  };

  items.forEach((item) => {
    EXPLICIT_SINGLE_LINK_FIELDS.forEach((field) => {
      const target = toStringSafe(item.data[field]);
      if (target) link(item.id, target, field);
    });

    EXPLICIT_ARRAY_LINK_FIELDS.forEach((field) => {
      const targets = Array.isArray(item.data[field]) ? item.data[field] : [];
      targets.forEach((target) => link(item.id, toStringSafe(target), field));
    });

    const compatibilityIds = Array.isArray(item.data.studentIds)
      ? item.data.studentIds
      : [];
    compatibilityIds.forEach((targetValue) => {
      const target = byId.get(toStringSafe(targetValue));
      if (!target) return;
      const sameDocument =
        item.documentKey && item.documentKey === target.documentKey;
      const sameEmailAndName =
        item.emailKey &&
        item.emailKey === target.emailKey &&
        item.nameKey &&
        item.nameKey === target.nameKey;
      if (sameDocument || sameEmailAndName) {
        link(
          item.id,
          target.id,
          sameDocument ? "studentIds_document" : "studentIds_email"
        );
      }
    });
  });

  groupBy(items, (item) => item.documentKey).forEach((group) => {
    if (group.length < 2) return;
    for (let index = 1; index < group.length; index += 1) {
      link(group[0].id, group[index].id, "documentFingerprint");
    }
  });

  const pendingCandidateGroups = [];
  groupBy(items, (item) => item.emailKey).forEach((emailGroup) => {
    groupBy(emailGroup, (item) => item.nameKey).forEach((sameIdentityGroup) => {
      if (sameIdentityGroup.length < 2) return;
      const stuItems = sameIdentityGroup.filter((item) => item.isStu);
      const canonicalItems = sameIdentityGroup.filter((item) => !item.isStu);
      if (!stuItems.length || !canonicalItems.length) return;

      if (canonicalItems.length === 1) {
        sameIdentityGroup.forEach((item) => {
          if (item.id !== canonicalItems[0].id) {
            link(canonicalItems[0].id, item.id, "emailNormalized");
          }
        });
        return;
      }

      pendingCandidateGroups.push(sameIdentityGroup);
    });
  });

  const groups = new Map();
  items.forEach((item) => {
    const root = find(item.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item);
  });

  const consumedPendingIds = new Set();
  const pending = pendingCandidateGroups.map((candidateGroup) => {
    candidateGroup.forEach((item) => consumedPendingIds.add(item.id));
    return buildPendingStudent(candidateGroup);
  });

  const resolved = [...groups.values()]
    .filter((group) => !group.some((item) => consumedPendingIds.has(item.id)))
    .map((group) => {
      const evidence = new Set();
      for (let left = 0; left < group.length; left += 1) {
        for (let right = left + 1; right < group.length; right += 1) {
          const pairKey = [group[left].id, group[right].id].sort().join("|");
          (evidenceByPair.get(pairKey) || []).forEach((value) => evidence.add(value));
        }
      }
      return buildLogicalStudent(group, [...evidence]);
    });

  return [...resolved, ...pending];
}

export function getLogicalStudentLinkedIds(student = {}) {
  return uniqueStrings([
    student.canonicalStudentId,
    student.studentId,
    student.id,
    student.academicRecordId,
    ...(Array.isArray(student.linkedStudentIds) ? student.linkedStudentIds : []),
  ]);
}

export function getLogicalStudentAcademicId(student = {}) {
  return (
    toStringSafe(student.academicRecordId) ||
    toStringSafe(student.canonicalStudentId) ||
    toStringSafe(student.studentId) ||
    toStringSafe(student.id)
  );
}

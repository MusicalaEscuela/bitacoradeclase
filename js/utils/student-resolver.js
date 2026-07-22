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

function buildLogicalStudent(group = [], evidence = [], confirmedLink = null) {
  const canonical =
    group.find((item) => item.id === confirmedLink?.canonicalStudentId) ||
    [...group].sort((left, right) => canonicalScore(right) - canonicalScore(left))[0] ||
    group[0];
  const academicCandidates = [...group].sort((left, right) => {
    const scoreDelta = academicScore(right) - academicScore(left);
    if (scoreDelta) return scoreDelta;
    if (left.isStu !== right.isStu) return right.isStu ? 1 : -1;
    return left.id.localeCompare(right.id);
  });
  const bestAcademic =
    group.find((item) => item.id === confirmedLink?.academicRecordId) ||
    academicCandidates[0] ||
    canonical;
  const academic =
    confirmedLink || academicScore(bestAcademic) > academicScore(canonical)
      ? bestAcademic
      : canonical;

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
    identityLinkStatus: confirmedLink?.status || "",
    identityLinkMethod: confirmedLink?.linkMethod || "",
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
    identityResolutionCandidates: items.map((item) => ({
      ...item.data,
      id: item.id,
      studentId: item.id,
      isHistorical: item.isStu,
    })),
  };
}

export function resolveLogicalStudents(records = [], identityLinkRecords = []) {
  const items = records.map(createItem).filter((item) => item.id);
  const byId = new Map(items.map((item) => [item.id, item]));
  const { find, union } = createDisjointSet([...byId.keys()]);
  const evidenceByPair = new Map();
  const confirmedLinks = identityLinkRecords.filter(
    (record) => record?.status === "confirmed"
  );
  const rejectedPairs = new Set(
    identityLinkRecords
      .filter((record) => record?.status === "rejected")
      .map((record) =>
        [record.canonicalStudentId, record.academicRecordId].sort().join("|")
      )
  );
  const confirmedLinkByMember = new Map();

  const link = (left, right, evidence) => {
    if (!byId.has(left) || !byId.has(right) || left === right) return;
    const pairKey = [left, right].sort().join("|");
    if (!evidenceByPair.has(pairKey)) evidenceByPair.set(pairKey, new Set());
    evidenceByPair.get(pairKey).add(evidence);
    union(left, right);
  };

  confirmedLinks.forEach((confirmedLink) => {
    const canonicalStudentId = toStringSafe(confirmedLink.canonicalStudentId);
    const members = uniqueStrings([
      canonicalStudentId,
      confirmedLink.academicRecordId,
      ...(Array.isArray(confirmedLink.linkedStudentIds)
        ? confirmedLink.linkedStudentIds
        : []),
    ]);
    members.forEach((memberId) => {
      confirmedLinkByMember.set(memberId, confirmedLink);
      if (memberId !== canonicalStudentId) {
        link(canonicalStudentId, memberId, "admin-confirmed");
      }
    });
  });

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
      const automaticGroup = sameIdentityGroup.filter(
        (item) => !confirmedLinkByMember.has(item.id)
      );
      const stuItems = automaticGroup.filter((item) => item.isStu);
      const canonicalItems = automaticGroup.filter((item) => !item.isStu);
      if (!stuItems.length || !canonicalItems.length) return;

      if (canonicalItems.length === 1) {
        automaticGroup.forEach((item) => {
          if (item.id !== canonicalItems[0].id) {
            const pair = [canonicalItems[0].id, item.id].sort().join("|");
            if (rejectedPairs.has(pair)) return;
            link(canonicalItems[0].id, item.id, "emailNormalized");
          }
        });
        return;
      }

      const pendingItems = automaticGroup.filter((item) => {
        if (!item.isStu) return true;
        return canonicalItems.some(
          (canonical) =>
            !rejectedPairs.has([canonical.id, item.id].sort().join("|"))
        );
      });
      if (pendingItems.some((item) => item.isStu)) {
        pendingCandidateGroups.push(pendingItems);
      }
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
      const confirmedLink = group
        .map((item) => confirmedLinkByMember.get(item.id))
        .find(Boolean);
      return buildLogicalStudent(group, [...evidence], confirmedLink);
    });

  /*
    Coincidencias solo por nombre NO se unen. Se anotan como sugerencias
    administrativas manteniendo cada tarjeta independiente hasta que exista
    un vínculo confirmado por la Function.
  */
  const suggestionsById = new Map();
  groupBy(items, (item) => item.nameKey).forEach((nameGroup, nameKey) => {
    const candidates = nameGroup.filter(
      (item) =>
        !confirmedLinkByMember.has(item.id) &&
        !consumedPendingIds.has(item.id)
    );
    const canonicalItems = candidates.filter((item) => !item.isStu);
    const stuItems = candidates.filter((item) => item.isStu);

    /*
      Caso A (identidad oficial disponible): hay al menos un canónico y un STU
      con el mismo nombre. Se sugiere vincular el STU al canónico.

      Caso B (duplicado sin identidad oficial): dos o más STU del mismo nombre
      y NINGÚN canónico (ej. Daniel: dos filas de la hoja sin cédula/email).
      El motor no puede elegir un oficial; se marca como pendiente para que un
      admin lo revise (registrar en Formulario/RIP o unir provisionalmente).
    */
    const officialAvailable = canonicalItems.length > 0;
    if (officialAvailable && !stuItems.length) return;
    if (!officialAvailable && stuItems.length < 2) return;

    const available = candidates.filter((item) => {
      if (!item.isStu) return true;
      if (!officialAvailable) return true;
      return canonicalItems.some(
        (canonical) =>
          !rejectedPairs.has([canonical.id, item.id].sort().join("|"))
      );
    });
    if (!available.some((item) => item.isStu)) return;
    if (!officialAvailable && available.filter((item) => item.isStu).length < 2) return;
    available.forEach((item) => {
      suggestionsById.set(item.id, { nameKey, candidates: available, officialAvailable });
    });
  });

  const annotatedResolved = resolved.map((student) => {
    if (student.identityResolutionStatus !== "single") return student;
    const suggestion = suggestionsById.get(student.id);
    if (!suggestion) return student;
    return {
      ...student,
      identityResolutionStatus: "pending",
      identityResolutionLabel: suggestion.officialAvailable
        ? "Revisión de identidad pendiente"
        : "Duplicado sin identidad oficial",
      identityResolutionOfficialAvailable: suggestion.officialAvailable,
      identityResolutionKind: suggestion.officialAvailable
        ? "name-suggestion"
        : "duplicate-stu",
      identityResolutionEvidence: [
        suggestion.officialAvailable
          ? "name-only-admin-review"
          : "duplicate-stu-no-canonical",
      ],
      identityResolutionSuggestionKey: `name:${suggestion.nameKey}`,
      identityResolutionCandidateCount: suggestion.candidates.length,
      identityResolutionCandidates: suggestion.candidates.map((item) => ({
        ...item.data,
        id: item.id,
        studentId: item.id,
        isHistorical: item.isStu,
      })),
    };
  });

  return [...annotatedResolved, ...pending];
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

function text(value) {
  return String(value ?? "").trim();
}

function uniqueTexts(values = []) {
  return [...new Set(values.map(text).filter(Boolean))];
}

function valuesFromRefs(values = [], fields = ["id"]) {
  if (!Array.isArray(values)) return [];

  return values.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    return fields.map((field) => item[field]);
  });
}

function normalizedDate(value) {
  const raw = text(value);
  if (!raw) return "";
  return raw.includes("T") ? raw.slice(0, 10) : raw;
}

function participantAliases(value) {
  if (Array.isArray(value)) return uniqueTexts(value);

  if (value && typeof value === "object") {
    return uniqueTexts([
      value.id,
      value.studentId,
      value.studentKey,
      value.academicRecordId,
      ...(Array.isArray(value.linkedStudentIds) ? value.linkedStudentIds : []),
      ...(Array.isArray(value.aliases) ? value.aliases : []),
    ]);
  }

  return uniqueTexts([value]);
}

/**
 * Contrato único de cobertura de una bitácora.
 *
 * `studentId` y `primaryStudentId` se conservan por compatibilidad, pero una
 * bitácora grupal pertenece a TODOS los ids de studentIds/studentRefs.
 */
export function getBitacoraParticipantIds(item = {}) {
  return uniqueTexts([
    ...(Array.isArray(item.studentIds) ? item.studentIds : []),
    ...valuesFromRefs(item.studentRefs, ["id", "studentId"]),
    item.primaryStudentId,
    item.studentId,
  ]);
}

export function isGroupBitacora(item = {}) {
  const refsCount = Array.isArray(item.studentRefs) ? item.studentRefs.length : 0;
  return (
    text(item.mode || item.modo).toLowerCase() === "group" ||
    getBitacoraParticipantIds(item).length > 1 ||
    refsCount > 1
  );
}

export function bitacoraBelongsToStudent(item = {}, studentOrIds = []) {
  const aliases = new Set(participantAliases(studentOrIds));
  if (!aliases.size) return false;

  return getBitacoraParticipantIds(item).some((id) => aliases.has(id));
}

function overrideProcessKey(item = {}, aliases = []) {
  const overrides =
    item.studentOverrides && typeof item.studentOverrides === "object"
      ? item.studentOverrides
      : {};

  for (const alias of aliases) {
    const override = overrides[alias];
    const processKey = text(override?.processKey || override?.processRef);
    if (processKey) return processKey;
  }

  return "";
}

/**
 * Filtra por el proceso DEL estudiante consultado. En una grupal, el proceso
 * superior corresponde al principal y los demás usan studentOverrides.
 */
export function bitacoraMatchesStudentProcess(
  item = {},
  {
    studentIds = [],
    processKey = "",
    processDetails = [],
    normalize = (value) => text(value).toLowerCase(),
  } = {}
) {
  const aliases = participantAliases(studentIds);
  const safeProcessKey = text(processKey);
  const normalizedDetails = uniqueTexts(processDetails).map(normalize).filter(Boolean);

  if (!safeProcessKey && !normalizedDetails.length) return true;

  const belongs = bitacoraBelongsToStudent(item, aliases);
  const group = isGroupBitacora(item);
  const perStudentProcessKey = group && belongs
    ? overrideProcessKey(item, aliases)
    : "";

  if (perStudentProcessKey) {
    return !safeProcessKey || perStudentProcessKey === safeProcessKey;
  }

  if (group && belongs) {
    const primaryIds = new Set(
      uniqueTexts([item.primaryStudentId, item.studentId])
    );
    const isPrimary = aliases.some((id) => primaryIds.has(id));

    // En registros antiguos sin override, el proceso superior describe al
    // principal. Los otros integrantes deben conservar la clase visible.
    if (!isPrimary) return true;
  }

  const itemProcessKey = text(item?.process?.processKey || item.processKey);
  if (safeProcessKey && itemProcessKey) {
    return itemProcessKey === safeProcessKey;
  }

  if (!normalizedDetails.length) return !safeProcessKey;

  const itemDetails = [
    item?.process?.processLabel,
    item?.process?.label,
    item?.process?.programa,
    item?.process?.detalle,
    item?.process?.area,
  ]
    .flatMap((value) => String(value || "").split(/,|;|\n/g))
    .map(normalize)
    .filter(Boolean);

  if (!itemProcessKey && !itemDetails.length) return true;
  return itemDetails.some((detail) => normalizedDetails.includes(detail));
}

/**
 * Consume pendientes como multiconjunto: una bitácora cubre una clase por
 * cada integrante y fecha. La misma grupal puede completar una fila de cada
 * estudiante, pero no dos filas duplicadas del mismo estudiante.
 */
export function consumePendingClasses(pendingRows = [], bitacoras = []) {
  const coverage = [];

  bitacoras.forEach((item, bitacoraIndex) => {
    const date = normalizedDate(
      item.fechaClase || item.date || item.fecha || item.createdAt
    );
    if (!date) return;

    getBitacoraParticipantIds(item).forEach((studentId) => {
      coverage.push({
        key: `${text(item.id || item.bitacoraId || bitacoraIndex)}::${studentId}`,
        studentId,
        date,
        item,
        used: false,
      });
    });
  });

  const completed = [];
  const pending = [];

  pendingRows.forEach((row) => {
    const aliases = participantAliases(
      row.studentIds || row.studentId || row.student
    );
    const date = normalizedDate(row.fechaClase || row.date || row.fecha);
    const match = coverage.find(
      (entry) =>
        !entry.used &&
        entry.date === date &&
        aliases.includes(entry.studentId)
    );

    if (!match) {
      pending.push(row);
      return;
    }

    match.used = true;
    completed.push({ row, bitacora: match.item });
  });

  return { pending, completed };
}

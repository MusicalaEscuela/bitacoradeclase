import {
  normalizeLocalDateInput,
  normalizeText,
  toStringSafe,
} from "./shared.js";

const IMPORT_MODES = {
  group: "group",
  individual: "individual",
};

export function normalizeHeaderName(value) {
  return normalizeText(value).replace(/[^a-z0-9]/g, "");
}

export function detectDelimiter(text) {
  const sample = String(text || "").slice(0, 1000);
  return sample.includes("\t") ? "\t" : ",";
}

export function splitDelimitedRows(text) {
  const safeText = String(text || "").replace(/\r/g, "").trim();
  if (!safeText) return [];

  const delimiter = detectDelimiter(safeText);
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < safeText.length; index += 1) {
    const char = safeText[index];
    const nextChar = safeText[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      row.push(toStringSafe(cell));
      cell = "";
      continue;
    }

    if (char === "\n" && !inQuotes) {
      row.push(toStringSafe(cell));
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(toStringSafe(cell));
  if (row.some(Boolean)) rows.push(row);

  return rows;
}

export function normalizeCellList(value) {
  return String(value || "")
    .split(/,|;|\n/g)
    .map((item) => toStringSafe(item))
    .filter(Boolean);
}

export function normalizeLinkList(value) {
  return String(value || "")
    .split(/,|;|\n/g)
    .map((item) => {
      const safeItem = toStringSafe(item);
      const markdownMatch = safeItem.match(/\((https?:\/\/[^)]+)\)/i);
      return markdownMatch ? markdownMatch[1] : safeItem;
    })
    .filter((item) => /^https?:\/\//i.test(item));
}

export function parseFlexibleDate(value) {
  const raw = toStringSafe(value);
  if (!raw) return "";

  const dmyMatch = raw.match(
    /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (dmyMatch) {
    const day = Number(dmyMatch[1]);
    const month = Number(dmyMatch[2]);
    const year = Number(dmyMatch[3].length === 2 ? `20${dmyMatch[3]}` : dmyMatch[3]);
    const hours = Number(dmyMatch[4] || 0);
    const minutes = Number(dmyMatch[5] || 0);
    const seconds = Number(dmyMatch[6] || 0);
    const parsed = new Date(year, month - 1, day, hours, minutes, seconds);

    if (!Number.isNaN(parsed.getTime())) {
      return [
        parsed.getFullYear(),
        String(parsed.getMonth() + 1).padStart(2, "0"),
        String(parsed.getDate()).padStart(2, "0"),
      ].join("-");
    }
  }

  return normalizeLocalDateInput(raw) || raw;
}

export function extractStudentName(rawStudent) {
  const safe = toStringSafe(rawStudent);
  if (!safe) return "";
  return toStringSafe(safe.split(/\s+-\s*/)[0] || safe);
}

export function extractStudentProcessHint(rawStudent) {
  const hints = splitStudentEntries(rawStudent)
    .map((entry) => {
      if (!/\s+-\s*/.test(entry)) return "";
      const parts = entry.split(/\s+-\s*/).map((part) => toStringSafe(part)).filter(Boolean);
      return parts.length < 2 ? "" : parts.slice(1).join(" - ");
    })
    .filter(Boolean);
  return [...new Set(hints)].join(", ");
}

export function splitStudentEntries(rawStudent) {
  return toStringSafe(rawStudent)
    .split(",")
    .map((entry) => toStringSafe(entry))
    .filter(Boolean);
}

export function extractStudentNames(rawStudent) {
  return [
    ...new Set(splitStudentEntries(rawStudent).map(extractStudentName).filter(Boolean)),
  ];
}

export function mapBitacoraRow(row = [], headerIndex = {}) {
  const getByIndex = (index) => toStringSafe(row[index]);
  const getByHeader = (...aliases) => {
    for (const alias of aliases) {
      const position = headerIndex[alias];
      if (Number.isInteger(position)) {
        const value = toStringSafe(row[position]);
        if (value) return value;
      }
    }
    return "";
  };

  const fechaClase = getByHeader("fecha", "fechaclase", "date") || getByIndex(0);
  const docente = getByHeader("docente", "teacher", "profesor") || getByIndex(1);
  const estudianteRaw =
    getByHeader("estudiante", "alumno", "student", "nombreestudiante") ||
    getByIndex(2);
  const content =
    getByHeader(
      "tareasobservaciones",
      "tareas",
      "observaciones",
      "contenido",
      "content",
      "apuntes"
    ) || getByIndex(3);
  const tagsRaw =
    getByHeader("categorias", "categoria", "tags", "etiquetas") || getByIndex(4);
  const componenteCorporal =
    getByHeader("componentecorporal", "corporal") || getByIndex(5);
  const componenteTecnico =
    getByHeader("componentetecnico", "tecnico") || getByIndex(6);
  const componenteTeorico =
    getByHeader("componenteteorico", "teorico") || getByIndex(7);
  const componenteObras =
    getByHeader("componentedeobras", "componenteobras", "obras") || getByIndex(8);
  const componenteComplementario =
    getByHeader("componentecomplementario", "complementario") || getByIndex(9);
  const imagenes =
    getByHeader("imagenes", "imagen", "fotos", "foto", "images", "image") ||
    getByIndex(10);
  const videos = getByHeader("videos", "video") || getByIndex(11);

  return {
    fechaClase: parseFlexibleDate(fechaClase),
    docente,
    estudianteRaw,
    estudianteNombres: extractStudentNames(estudianteRaw),
    estudianteProcesoHint: extractStudentProcessHint(estudianteRaw),
    content,
    tags: normalizeCellList(tagsRaw),
    componenteCorporal: normalizeCellList(componenteCorporal),
    componenteTecnico: normalizeCellList(componenteTecnico),
    componenteTeorico: normalizeCellList(componenteTeorico),
    componenteObras: normalizeCellList(componenteObras),
    componenteComplementario: normalizeCellList(componenteComplementario),
    imagenes: normalizeLinkList(imagenes),
    videos: normalizeLinkList(videos),
  };
}

export function parseBitacoraRows(rows = [], explicitHeaderIndex = null) {
  if (!Array.isArray(rows) || !rows.length) return [];

  const headers = rows[0].map((cell) => normalizeHeaderName(cell));
  const hasHeader =
    explicitHeaderIndex !== null ||
    headers.includes("fecha") ||
    headers.includes("estudiante") ||
    headers.includes("tareasobservaciones") ||
    headers.includes("categorias");
  const headerIndex = explicitHeaderIndex || {};

  if (hasHeader && !explicitHeaderIndex) {
    headers.forEach((name, index) => {
      if (name && headerIndex[name] === undefined) headerIndex[name] = index;
    });
  }

  return (hasHeader ? rows.slice(1) : rows).map((row) =>
    mapBitacoraRow(row, hasHeader ? headerIndex : {})
  );
}

export function parseBitacoraSheetText(text) {
  const rows = splitDelimitedRows(text);
  return {
    rows,
    items: parseBitacoraRows(rows),
  };
}

export function buildStudentNameIndex(students = []) {
  const index = new Map();

  (Array.isArray(students) ? students : []).forEach((student) => {
    const id = toStringSafe(student?.studentKey || student?.id || student?.studentId);
    const name = toStringSafe(student?.nombre || student?.name || student?.estudiante);
    if (!id || !name) return;
    const normalized = normalizeText(name);
    if (normalized && !index.has(normalized)) index.set(normalized, student);
  });

  return index;
}

export function matchStudentsFromParsedRow(parsedRow = {}, allStudents = []) {
  const studentByName = buildStudentNameIndex(allStudents);
  const matchedStudents = [];
  const unresolvedStudents = [];
  const seenIds = new Set();

  (parsedRow.estudianteNombres || []).forEach((name) => {
    const normalizedName = normalizeText(name);
    if (!normalizedName) return;

    const student = studentByName.get(normalizedName);
    if (!student) {
      unresolvedStudents.push(name);
      return;
    }

    const id = toStringSafe(student?.studentKey || student?.id || student?.studentId);
    if (!id || seenIds.has(id)) return;
    seenIds.add(id);
    matchedStudents.push(student);
  });

  return {
    matchedStudents,
    unresolvedStudents: [...new Set(unresolvedStudents)],
  };
}

export function resolveImportedProcess(student, parsedRow = {}) {
  return {
    processKey: "",
    processLabel: "",
    area: "",
    modalidad: "",
    docente: toStringSafe(parsedRow?.docente || student?.docente),
    sede: "",
    programa: "",
  };
}

export function createBitacoraPayloadFromRow(parsedRow, students = []) {
  const linkedStudents = (Array.isArray(students) ? students : [])
    .map((student) => {
      const id = toStringSafe(student?.studentKey || student?.id || student?.studentId);
      const name = toStringSafe(student?.nombre || student?.name || student?.estudiante);
      return id ? { id, name: name || id, source: student } : null;
    })
    .filter(Boolean);

  if (!linkedStudents.length) return null;

  const primary = linkedStudents[0];
  const content = toStringSafe(parsedRow.content);
  const process = resolveImportedProcess(primary.source, parsedRow);
  const isGroup = linkedStudents.length > 1;
  const studentIds = linkedStudents.map((item) => item.id);
  const studentRefs = linkedStudents.map((item) => ({ id: item.id, name: item.name }));
  const studentOverrides = {};

  linkedStudents.forEach((item) => {
    studentOverrides[item.id] = {
      enabled: true,
      tareas: content,
      etiquetas: parsedRow.componenteComplementario,
      componenteCorporal: parsedRow.componenteCorporal,
      componenteTecnico: parsedRow.componenteTecnico,
      componenteTeorico: parsedRow.componenteTeorico,
      componenteObras: parsedRow.componenteObras,
    };
  });

  const titleBase = isGroup
    ? `Bitacora grupal (${linkedStudents.length})`
    : `Bitacora ${primary.name}`;

  return {
    mode: isGroup ? IMPORT_MODES.group : IMPORT_MODES.individual,
    studentId: primary.id,
    studentKey: primary.id,
    studentIds,
    studentRefs,
    primaryStudentId: primary.id,
    title: `${titleBase}${parsedRow.fechaClase ? ` - ${parsedRow.fechaClase}` : ""}`,
    content,
    fechaClase: parsedRow.fechaClase || "",
    tags: parsedRow.tags,
    studentOverrides,
    process: {
      processKey: process.processKey,
      processLabel: process.processLabel,
      area: process.area,
      modalidad: process.modalidad,
      docente: process.docente,
      sede: process.sede,
      programa: process.programa,
    },
    source: "csv_import",
    metadata: {
      importSource: "settings_csv",
      importedAt: new Date().toISOString(),
      importedAsGroup: isGroup,
      importedStudentCount: linkedStudents.length,
    },
  };
}

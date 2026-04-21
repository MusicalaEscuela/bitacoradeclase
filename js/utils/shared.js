// js/utils/shared.js

import { CONFIG } from "../config.js";

/* ==========================================================================
   BASE
   ========================================================================== */

export function toStringSafe(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function toArraySafe(value) {
  return Array.isArray(value) ? value : [];
}

export function uniqueStrings(values = []) {
  return [
    ...new Set(
      toArraySafe(values)
        .map((item) => toStringSafe(item))
        .filter(Boolean)
    ),
  ];
}

export function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = toStringSafe(value);
    if (normalized) return normalized;
  }
  return "";
}

/* ==========================================================================
   UI / TEXTO
   ========================================================================== */

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function getReadableValue(value, fallback = "No registrado") {
  const clean = toStringSafe(value);
  return clean || fallback;
}

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/* ==========================================================================
   FECHAS
   ========================================================================== */

export function getTimestamp(value) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function formatDisplayDate(value) {
  if (!value) return "Sin fecha";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return new Intl.DateTimeFormat("es-CO", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

export function getTodayDate() {
  return new Date().toISOString().slice(0, 10);
}

/* ==========================================================================
   MODOS / LISTAS
   ========================================================================== */

export function normalizeMode(mode) {
  return toStringSafe(mode) === CONFIG.modes.group
    ? CONFIG.modes.group
    : CONFIG.modes.individual;
}

export function normalizeTags(tags) {
  if (Array.isArray(tags)) {
    return uniqueStrings(tags);
  }

  if (typeof tags === "string") {
    return uniqueStrings(tags.split(","));
  }

  return [];
}

export function normalizeStudentIds(studentIds) {
  if (!Array.isArray(studentIds)) return [];
  return uniqueStrings(studentIds);
}

export function normalizeStudentRefs(studentRefs) {
  if (!Array.isArray(studentRefs)) return [];

  const seen = new Set();

  return studentRefs
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      id: toStringSafe(item.id),
      name: toStringSafe(item.name),
    }))
    .filter((item) => {
      if (!item.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
}

export function sortBitacorasByDate(items = []) {
  return [...toArraySafe(items)].sort((a, b) => {
    const dateA = getTimestamp(a?.fechaClase || a?.createdAt || a?.updatedAt);
    const dateB = getTimestamp(b?.fechaClase || b?.createdAt || b?.updatedAt);
    return dateB - dateA;
  });
}

/**
 * Ojo:
 * NO normaliza cada bitácora por sí sola porque profile/editor
 * hoy no usan exactamente la misma implementación.
 * Recibe el normalizador desde afuera para no romper comportamiento.
 */
export function normalizeBitacorasResponse(response, normalizeItem = (item) => item) {
  if (Array.isArray(response)) {
    return response.map(normalizeItem).filter(Boolean);
  }

  if (Array.isArray(response?.data)) {
    return response.data.map(normalizeItem).filter(Boolean);
  }

  if (Array.isArray(response?.items)) {
    return response.items.map(normalizeItem).filter(Boolean);
  }

  if (Array.isArray(response?.bitacoras)) {
    return response.bitacoras.map(normalizeItem).filter(Boolean);
  }

  return [];
}

/* ==========================================================================
   ESTUDIANTES
   ========================================================================== */

export function getStudentName(student) {
  return (
    student?.nombre ||
    student?.name ||
    student?.estudiante ||
    "Sin nombre"
  );
}

export function getStudentDocument(student) {
  return (
    student?.documento ||
    student?.identificacion ||
    student?.cc ||
    student?.studentKey ||
    ""
  );
}

export function matchesStudentRef(student, studentRef) {
  const safeRef = toStringSafe(studentRef);
  if (!student || !safeRef) return false;

  return [
    student?.studentKey,
    student?.id,
    student?.studentId,
    student?.documento,
    student?.identificacion,
    student?.cc,
    student?.sourceRow,
  ].some((value) => toStringSafe(value) === safeRef);
}

export function findStudentInCollections(state, studentRef) {
  const safeRef = toStringSafe(studentRef);
  if (!safeRef) return null;

  const byId = state?.students?.byId;
  if (byId && isPlainObject(byId)) {
    if (byId[safeRef]) return byId[safeRef];

    const byIdValues = Object.values(byId);
    const foundInMap = byIdValues.find((item) =>
      matchesStudentRef(item, safeRef)
    );
    if (foundInMap) return foundInMap;
  }

  const lists = [
    state?.search?.results,
    state?.search?.filteredResults,
    Array.isArray(state?.students?.allIds) && isPlainObject(state?.students?.byId)
      ? state.students.allIds
          .map((id) => state.students.byId?.[id])
          .filter(Boolean)
      : [],
  ];

  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    const found = list.find((item) => matchesStudentRef(item, safeRef));
    if (found) return found;
  }

  return null;
}

export function resolveStudentRefFromPayload(payload) {
  return payload?.studentKey || payload?.studentId || payload?.id || null;
}

export function getStudentIdentity(student) {
  if (!student) return "";
  return (
    toStringSafe(student.studentKey) ||
    toStringSafe(student.id) ||
    toStringSafe(student.studentId) ||
    toStringSafe(student.documento)
  );
}

export function getStudentFallbackId(student) {
  if (!student) return "";
  return (
    toStringSafe(student.id) ||
    toStringSafe(student.studentId) ||
    toStringSafe(student.documento)
  );
}

export function getStudentProcessesSummary(student) {
  const processes = Array.isArray(student?.processes) ? student.processes : [];

  if (!processes.length) {
    return firstNonEmpty(
      student?.programa,
      student?.instrumento,
      student?.area
    );
  }

  return processes
    .map((item) => item?.label || item?.arte || item?.detalle)
    .filter(Boolean)
    .join(" • ");
}
export function slugifyProcessKey(value) {
  const normalized = toStringSafe(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized || "general";
}

export function normalizeStudentProcesses(student = {}) {
  const rawProcesses = Array.isArray(student?.processes) ? student.processes : [];

  if (!rawProcesses.length) {
    const fallbackArte = firstNonEmpty(student?.area);
    const fallbackDetalle = firstNonEmpty(student?.instrumento, student?.programa);
    const fallbackLabel = firstNonEmpty(
      student?.programa,
      student?.instrumento,
      student?.area,
      "Proceso general"
    );

    return [
      {
        processKey: `fallback_${slugifyProcessKey(fallbackLabel)}`,
        arte: fallbackArte,
        detalle: fallbackDetalle,
        label: fallbackLabel,
      },
    ];
  }

  return rawProcesses
    .map((process, index) => {
      if (!process || typeof process !== "object") return null;

      const arte = toStringSafe(process.arte || process.area);
      const detalle = toStringSafe(process.detalle || process.instrumento);
      const label =
        toStringSafe(process.label) ||
        [arte, detalle].filter(Boolean).join(" - ") ||
        `Proceso ${index + 1}`;

      return {
        processKey:
          toStringSafe(process.processKey) ||
          `${slugifyProcessKey(arte || label)}_${slugifyProcessKey(detalle || label)}_${index + 1}`,
        arte,
        detalle,
        label,
      };
    })
    .filter(Boolean);
}

export function resolveStudentProcess(student = {}, processRef = "") {
  const processes = normalizeStudentProcesses(student);
  const safeRef = toStringSafe(processRef);

  if (!safeRef) return processes[0] || null;

  return (
    processes.find((process) => toStringSafe(process.processKey) === safeRef) ||
    processes.find((process) => normalizeText(process.label) === normalizeText(safeRef)) ||
    processes[0] ||
    null
  );
}

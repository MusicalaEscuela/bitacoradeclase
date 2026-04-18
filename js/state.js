// js/state.js

import {
  CONFIG,
  buildDraftKey,
  buildGroupDraftKey,
  getDefaultEditorState,
} from "./config.js";

import {
  toStringSafe,
  toArraySafe,
  isPlainObject,
  uniqueStrings,
  normalizeMode,
  getTimestamp,
} from "./utils/shared.js";

/* ==========================================================================
   HELPERS BASE
   (Solo los que son propios de state.js y no viven en shared.js)
   ========================================================================== */

function clone(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function getNowIso() {
  return new Date().toISOString();
}

function getRandomId(prefix = "id") {
  try {
    if (globalThis.crypto?.randomUUID) {
      return `${prefix}_${globalThis.crypto.randomUUID()}`;
    }
  } catch {
    // nada
  }

  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function deepMerge(target, source) {
  if (Array.isArray(source)) return [...source];
  if (!isPlainObject(target) || !isPlainObject(source)) return source;

  const output = { ...target };

  Object.keys(source).forEach((key) => {
    const sourceValue = source[key];
    const targetValue = output[key];

    if (Array.isArray(sourceValue)) {
      output[key] = [...sourceValue];
      return;
    }

    if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
      output[key] = deepMerge(targetValue, sourceValue);
      return;
    }

    output[key] = sourceValue;
  });

  return output;
}

function safeRoute(routeName) {
  const route = toStringSafe(routeName);
  const allowed = Object.values(CONFIG.routes || {});
  return allowed.includes(route) ? route : CONFIG.routes.search;
}

function extractStudentId(student) {
  if (!student || typeof student !== "object") return "";
  return (
    toStringSafe(student.studentKey) ||
    toStringSafe(student.id) ||
    toStringSafe(student.studentId) ||
    toStringSafe(student.estudianteId) ||
    toStringSafe(student.documento)
  );
}

function extractStudentKey(student) {
  if (!student || typeof student !== "object") return "";
  return toStringSafe(student.studentKey) || extractStudentId(student);
}

function extractStudentName(student) {
  if (!student || typeof student !== "object") return "";
  return (
    toStringSafe(student.nombreCompleto) ||
    toStringSafe(student.nombre) ||
    toStringSafe(student.name) ||
    toStringSafe(student.estudiante)
  );
}

// NOTA: esta versión de normalizeStudentRefs es más completa que la de shared.js.
// Maneja strings sueltos y campos alternos (studentId, studentKey, nombre, estudiante).
// NO reemplazar por la importada — se usa en hydratación de drafts y createEmptyDraft.
function normalizeStudentRefs(studentRefs = []) {
  const seen = new Set();

  return toArraySafe(studentRefs)
    .map((item) => {
      if (typeof item === "string") {
        return { id: toStringSafe(item), name: "" };
      }

      if (!item || typeof item !== "object") {
        return null;
      }

      return {
        id: toStringSafe(item.id || item.studentId || item.studentKey),
        name: toStringSafe(item.name || item.nombre || item.estudiante),
      };
    })
    .filter(Boolean)
    .filter((item) => {
      if (!item.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
}

function sortStudentIdsByName(byId = {}, ids = []) {
  return [...uniqueStrings(ids)].sort((a, b) => {
    const nameA = extractStudentName(byId[a] || {}).toLowerCase();
    const nameB = extractStudentName(byId[b] || {}).toLowerCase();
    return nameA.localeCompare(nameB, "es", { sensitivity: "base" });
  });
}

function normalizeStudentRecord(student = {}) {
  if (!student || typeof student !== "object") return null;

  const id = extractStudentId(student);
  if (!id) return null;

  return {
    ...student,
    id,
    studentId: toStringSafe(student.studentId) || id,
    studentKey: extractStudentKey(student) || id,
    nombre: toStringSafe(student.nombre) || extractStudentName(student),
  };
}

function normalizeStudentList(students = []) {
  const byId = {};
  const allIds = [];

  toArraySafe(students).forEach((student) => {
    const normalized = normalizeStudentRecord(student);
    if (!normalized) return;

    byId[normalized.id] = normalized;
    allIds.push(normalized.id);
  });

  return {
    byId,
    allIds: uniqueStrings(allIds),
  };
}

function normalizeProfileRecord(profile = {}) {
  if (!profile || typeof profile !== "object") return null;

  const id = extractStudentId(profile);
  if (!id) return null;

  return {
    ...profile,
    id,
    studentId: toStringSafe(profile.studentId) || id,
    studentKey: extractStudentKey(profile) || id,
  };
}

function normalizeBitacoraItem(item = {}) {
  if (!item || typeof item !== "object") return null;

  const id =
    toStringSafe(item.id) ||
    toStringSafe(item.bitacoraId) ||
    getRandomId("bitacora");

  const studentId = toStringSafe(item.studentId);
  const studentIds = uniqueStrings(item.studentIds || (studentId ? [studentId] : []));

  return {
    ...item,
    id,
    mode: normalizeMode(item.mode || item.modo),
    titulo: toStringSafe(item.titulo || item.title || "Bitácora sin título"),
    contenido: toStringSafe(item.contenido || item.content),
    etiquetas: uniqueStrings(item.etiquetas || item.tags),
    archivos: Array.isArray(item.archivos)
      ? [...item.archivos]
      : Array.isArray(item.attachments)
      ? [...item.attachments]
      : [],
    fechaClase: toStringSafe(item.fechaClase || item.fecha || item.classDate),
    studentId: studentId || null,
    studentIds,
    studentRefs: normalizeStudentRefs(item.studentRefs),
    studentOverrides: normalizeStudentOverrides(
      item.studentOverrides || item.overrides,
      studentIds
    ),
    createdAt: item.createdAt || item.created_at || item.fechaRegistro || null,
    updatedAt: item.updatedAt || item.updated_at || null,
  };
}

function sortBitacoras(items = []) {
  return [...toArraySafe(items)].sort((a, b) => {
    const aTime = getTimestamp(a?.fechaClase || a?.updatedAt || a?.createdAt);
    const bTime = getTimestamp(b?.fechaClase || b?.updatedAt || b?.createdAt);
    return bTime - aTime;
  });
}

function normalizeBitacorasMap(map = {}) {
  const next = {};

  Object.entries(isPlainObject(map) ? map : {}).forEach(([studentId, items]) => {
    const safeStudentId = toStringSafe(studentId);
    if (!safeStudentId) return;

    next[safeStudentId] = sortBitacoras(
      toArraySafe(items).map(normalizeBitacoraItem).filter(Boolean)
    );
  });

  return next;
}

function buildStudentRefsFromIds(ids = [], byId = {}) {
  return uniqueStrings(ids).map((id) => ({
    id,
    name: extractStudentName(byId[id] || {}),
  }));
}

function normalizeOverrideValues(values = []) {
  const source = Array.isArray(values) ? values : [values];

  return uniqueStrings(
    source
      .flatMap((value) =>
        String(value || "")
          .split(/,|;|\n/g)
          .map((item) => toStringSafe(item))
      )
      .filter(Boolean)
  );
}

function normalizeStudentOverrides(overrides = {}, allowedStudentIds = []) {
  const next = {};
  const allowedIds = new Set(uniqueStrings(allowedStudentIds));

  Object.entries(isPlainObject(overrides) ? overrides : {}).forEach(
    ([studentId, value]) => {
      const safeStudentId = toStringSafe(studentId);
      if (!safeStudentId || (allowedIds.size && !allowedIds.has(safeStudentId))) {
        return;
      }

      const normalizedValue = isPlainObject(value) ? value : {};
      const enabled = Boolean(normalizedValue.enabled);
      const tareas = toStringSafe(normalizedValue.tareas);
      const etiquetas = normalizeOverrideValues(normalizedValue.etiquetas);
      const componenteCorporal = normalizeOverrideValues(
        normalizedValue.componenteCorporal
      );
      const componenteTecnico = normalizeOverrideValues(
        normalizedValue.componenteTecnico
      );
      const componenteTeorico = normalizeOverrideValues(
        normalizedValue.componenteTeorico
      );
      const componenteObras = normalizeOverrideValues(
        normalizedValue.componenteObras
      );

      if (
        !enabled &&
        !tareas &&
        !etiquetas.length &&
        !componenteCorporal.length &&
        !componenteTecnico.length &&
        !componenteTeorico.length &&
        !componenteObras.length
      ) {
        return;
      }

      next[safeStudentId] = {
        enabled,
        tareas,
        etiquetas,
        componenteCorporal,
        componenteTecnico,
        componenteTeorico,
        componenteObras,
      };
    }
  );

  return next;
}

function createEmptyDraft(overrides = {}) {
  const base =
    typeof getDefaultEditorState === "function"
      ? getDefaultEditorState()
      : {
          mode: CONFIG.modes.individual,
          selectedStudentIds: [],
          attachments: [],
          title: "",
          content: "",
          tags: [],
        };

  const mode = normalizeMode(overrides.mode || base.mode);
  const studentId = toStringSafe(overrides.studentId);
  const studentKey = toStringSafe(overrides.studentKey || studentId);

  const studentIds = uniqueStrings(
    overrides.studentIds ||
      overrides.selectedStudentIds ||
      (studentId ? [studentId] : [])
  );

  const studentRefs = normalizeStudentRefs(
    overrides.studentRefs ||
      (studentId
        ? [{ id: studentId, name: toStringSafe(overrides.studentName) }]
        : [])
  );

  const normalizedStudentIds =
    mode === CONFIG.modes.group
      ? studentIds
      : uniqueStrings(studentIds.slice(0, 1));

  const normalizedStudentRefs =
    mode === CONFIG.modes.group ? studentRefs : studentRefs.slice(0, 1);

  const primaryId =
    mode === CONFIG.modes.group ? null : normalizedStudentIds[0] || null;

  return {
    mode,
    studentId: primaryId,
    studentKey: primaryId || studentKey || null,
    studentIds: normalizedStudentIds,
    studentRefs: normalizedStudentRefs,
    fechaClase: toStringSafe(overrides.fechaClase),
    titulo: toStringSafe(overrides.titulo || overrides.title || base.title),
    contenido: toStringSafe(
      overrides.contenido || overrides.content || base.content
    ),
    etiquetas: uniqueStrings(overrides.etiquetas || overrides.tags || base.tags),
    archivos: Array.isArray(overrides.archivos)
      ? [...overrides.archivos]
      : Array.isArray(overrides.attachments)
      ? [...overrides.attachments]
      : Array.isArray(base.attachments)
      ? [...base.attachments]
      : [],
    studentOverrides: normalizeStudentOverrides(
      overrides.studentOverrides || overrides.overrides,
      normalizedStudentIds
    ),
    updatedAt: overrides.updatedAt || getNowIso(),
  };
}

/* ==========================================================================
   ESTADO INICIAL
   ========================================================================== */

const initialState = {
  app: {
    ready: false,
    currentView: safeRoute(CONFIG.routes.search),
    loading: false,
    saving: false,
    error: null,
  },

  auth: {
    user: null,
    ready: false,
    isAuthenticated: false,
  },

  session: {
    user: null,
  },

  search: {
    query: "",
    filteredIds: [],
    selectedStudentIds: [],
    lastSearchAt: null,

    // Compat temporal con la arquitectura vieja
    results: [],
    filteredResults: [],
    selectedStudentId: null,
  },

  filters: {
    sede: "",
    modalidad: "",
    docente: "",
    area: "",
  },

  students: {
    byId: {},
    allIds: [],
    currentStudentId: null,
    loading: false,

    // Compat temporal
    selected: null,
    profile: null,
  },

  profile: {
    byStudentId: {},
    goalsByStudentId: {},
    routeByStudentId: {},
    loading: false,
    error: null,
  },

  bitacoras: {
    byStudentId: {},
    currentDraft: createEmptyDraft(),
    loading: false,
    saving: false,
    error: null,
    loadedStudentId: null,
    loadedStudentIds: [],
  },

  uploads: {
    queue: [],
    uploaded: [],
    uploading: false,
  },

  ui: {
    toasts: [],
    modal: null,
    sidebarOpen: false,
  },
};

let state = clone(initialState);
const listeners = new Set();

/* ==========================================================================
   FINALIZACIÓN / NORMALIZACIÓN GLOBAL
   ========================================================================== */

function finalizeState(rawState) {
  const merged = deepMerge(clone(initialState), rawState || {});

  merged.app.ready = Boolean(merged.app.ready);
  merged.app.currentView = safeRoute(merged.app.currentView);
  merged.app.loading = Boolean(merged.app.loading);
  merged.app.saving = Boolean(merged.app.saving);
  merged.app.error = merged.app.error ? String(merged.app.error) : null;

  merged.auth.user = normalizeAuthUser(merged.auth.user);
  merged.auth.ready = Boolean(merged.auth.ready);
  merged.auth.isAuthenticated = Boolean(merged.auth.user?.uid);
  merged.session.user = merged.auth.user ? clone(merged.auth.user) : null;

  merged.search.query =
    merged.search.query === null || merged.search.query === undefined
      ? ""
      : String(merged.search.query);
  merged.search.filteredIds = uniqueStrings(merged.search.filteredIds);
  merged.search.selectedStudentIds = uniqueStrings(merged.search.selectedStudentIds);
  merged.search.lastSearchAt = merged.search.lastSearchAt || null;

  merged.filters = {
    sede: toStringSafe(merged.filters.sede),
    modalidad: toStringSafe(merged.filters.modalidad),
    docente: toStringSafe(merged.filters.docente),
    area: toStringSafe(merged.filters.area),
  };

  merged.students.byId = normalizeStudentsMap(merged.students.byId);
  merged.students.allIds = sortStudentIdsByName(
    merged.students.byId,
    uniqueStrings(
      merged.students.allIds.length
        ? merged.students.allIds
        : Object.keys(merged.students.byId)
    )
  );
  merged.students.loading = Boolean(merged.students.loading);

  merged.profile.byStudentId = normalizeProfilesMap(merged.profile.byStudentId);
  merged.profile.goalsByStudentId = normalizeGoalsMap(merged.profile.goalsByStudentId);
  merged.profile.routeByStudentId = normalizeRouteMap(merged.profile.routeByStudentId);
  merged.profile.loading = Boolean(merged.profile.loading);
  merged.profile.error = merged.profile.error ? String(merged.profile.error) : null;

  merged.bitacoras.byStudentId = normalizeBitacorasMap(merged.bitacoras.byStudentId);
  merged.bitacoras.currentDraft = createEmptyDraft(merged.bitacoras.currentDraft);
  merged.bitacoras.loading = Boolean(merged.bitacoras.loading);
  merged.bitacoras.saving = Boolean(merged.bitacoras.saving);
  merged.bitacoras.error = merged.bitacoras.error ? String(merged.bitacoras.error) : null;
  merged.bitacoras.loadedStudentIds = uniqueStrings(merged.bitacoras.loadedStudentIds);
  merged.bitacoras.loadedStudentId = toStringSafe(merged.bitacoras.loadedStudentId) || null;

  merged.uploads.queue = toArraySafe(merged.uploads.queue);
  merged.uploads.uploaded = toArraySafe(merged.uploads.uploaded);
  merged.uploads.uploading = Boolean(merged.uploads.uploading);

  merged.ui.toasts = toArraySafe(merged.ui.toasts);
  merged.ui.modal = merged.ui.modal && isPlainObject(merged.ui.modal) ? merged.ui.modal : null;
  merged.ui.sidebarOpen = Boolean(merged.ui.sidebarOpen);

  syncCompatibility(merged);

  return merged;
}

function normalizeStudentsMap(byId = {}) {
  const next = {};
  Object.values(isPlainObject(byId) ? byId : {}).forEach((student) => {
    const normalized = normalizeStudentRecord(student);
    if (!normalized) return;
    next[normalized.id] = normalized;
  });
  return next;
}

function normalizeProfilesMap(byId = {}) {
  const next = {};
  Object.values(isPlainObject(byId) ? byId : {}).forEach((profile) => {
    const normalized = normalizeProfileRecord(profile);
    if (!normalized) return;
    next[normalized.id] = normalized;
  });
  return next;
}

function normalizeGoalsMap(byId = {}) {
  const next = {};
  Object.entries(isPlainObject(byId) ? byId : {}).forEach(([studentId, goals]) => {
    const safeId = toStringSafe(studentId);
    if (!safeId) return;

    next[safeId] = toArraySafe(goals).map((goal) => ({
      ...goal,
      id: toStringSafe(goal?.id) || getRandomId("goal"),
      title: toStringSafe(goal?.title || goal?.titulo),
      status: toStringSafe(goal?.status || goal?.estado || "pendiente"),
      progress: Number.isFinite(Number(goal?.progress))
        ? Number(goal.progress)
        : Number.isFinite(Number(goal?.avance))
        ? Number(goal.avance)
        : 0,
      notes: toStringSafe(goal?.notes || goal?.notas),
      updatedAt: goal?.updatedAt || goal?.fechaActualizacion || null,
    }));
  });
  return next;
}

function normalizeRouteMap(byId = {}) {
  const next = {};
  Object.entries(isPlainObject(byId) ? byId : {}).forEach(([studentId, route]) => {
    const safeId = toStringSafe(studentId);
    if (!safeId) return;

    next[safeId] = isPlainObject(route)
      ? {
          ...route,
          stage: toStringSafe(route.stage || route.etapa),
          milestones: Array.isArray(route.milestones)
            ? [...route.milestones]
            : Array.isArray(route.hitos)
            ? [...route.hitos]
            : [],
          recommendations: Array.isArray(route.recommendations)
            ? [...route.recommendations]
            : Array.isArray(route.recomendaciones)
            ? [...route.recomendaciones]
            : [],
        }
      : {};
  });
  return next;
}

function normalizeAuthUser(user = null) {
  if (!user || typeof user !== "object") return null;

  const uid = toStringSafe(user.uid);
  if (!uid) return null;

  return {
    uid,
    name: toStringSafe(user.name || user.displayName),
    email: toStringSafe(user.email),
    photoURL: toStringSafe(user.photoURL),
    role: toStringSafe(user.role || user.rol || "teacher").toLowerCase(),
    linkedStudentId: toStringSafe(
      user.linkedStudentId || user.studentId || user.studentKey
    ),
  };
}

function syncCompatibility(draftState) {
  const byId = draftState.students.byId;
  const allIds = draftState.students.allIds;
  const search = draftState.search;
  const students = draftState.students;
  const profile = draftState.profile;

  const validCurrentStudentId = allIds.includes(toStringSafe(students.currentStudentId))
    ? toStringSafe(students.currentStudentId)
    : allIds.includes(toStringSafe(search.selectedStudentId))
    ? toStringSafe(search.selectedStudentId)
    : null;

  students.currentStudentId = validCurrentStudentId;
  search.selectedStudentId = validCurrentStudentId;

  const selectedIds = uniqueStrings(search.selectedStudentIds).filter((id) => allIds.includes(id));
  search.selectedStudentIds = selectedIds;

  search.results = allIds.map((id) => byId[id]).filter(Boolean);

  const hasAppliedFilter = search.filteredIds.length > 0 || Boolean(search.query);
  const validFilteredIds = uniqueStrings(search.filteredIds).filter((id) => allIds.includes(id));
  search.filteredIds = validFilteredIds;
  search.filteredResults = hasAppliedFilter
    ? validFilteredIds.map((id) => byId[id]).filter(Boolean)
    : search.results;

  students.selected = validCurrentStudentId ? byId[validCurrentStudentId] || null : null;

  if (validCurrentStudentId) {
    const baseStudent = byId[validCurrentStudentId] || {};
    const fullProfile = profile.byStudentId[validCurrentStudentId] || null;

    students.profile = fullProfile
      ? {
          ...baseStudent,
          ...fullProfile,
          goals: profile.goalsByStudentId[validCurrentStudentId] || [],
          route: profile.routeByStudentId[validCurrentStudentId] || {},
        }
      : baseStudent;
  } else {
    students.profile = null;
  }

  if (!validCurrentStudentId) {
    if (draftState.app.currentView === CONFIG.routes.profile) {
      draftState.app.currentView = CONFIG.routes.search;
    }

    if (
      draftState.app.currentView === CONFIG.routes.editor &&
      draftState.bitacoras.currentDraft.mode !== CONFIG.modes.group
    ) {
      draftState.app.currentView = CONFIG.routes.search;
    }
  }
}

/* ==========================================================================
   CORE API
   ========================================================================== */

function notify() {
  const snapshot = getState();

  listeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch (error) {
      console.error("Error en listener de state:", error);
    }
  });
}

export function getState() {
  return clone(state);
}

export function subscribe(listener) {
  if (typeof listener !== "function") {
    throw new Error("subscribe requiere una función.");
  }

  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function setState(updater) {
  const nextState =
    typeof updater === "function" ? updater(clone(state)) : updater;

  if (!nextState || typeof nextState !== "object") {
    throw new Error("setState requiere un objeto de estado válido.");
  }

  state = finalizeState(nextState);
  notify();
}

export function patchState(partial) {
  if (!partial || typeof partial !== "object") return;
  state = finalizeState(deepMerge(state, partial));
  notify();
}

export function resetState() {
  state = finalizeState(clone(initialState));
  notify();
}

export function getSlice(sliceName) {
  return clone(state[sliceName]);
}

export function patchSlice(sliceName, partial) {
  if (!sliceName || !Object.prototype.hasOwnProperty.call(state, sliceName)) return;

  state = finalizeState({
    ...state,
    [sliceName]: deepMerge(state[sliceName], partial || {}),
  });

  notify();
}

/* ==========================================================================
   APP
   ========================================================================== */

export function setAppReady(isReady) {
  patchSlice("app", { ready: Boolean(isReady) });
}

export function setCurrentView(viewName) {
  const nextView = safeRoute(viewName);

  patchSlice("app", {
    currentView: nextView,
    error: null,
  });
}

export function setAppLoading(isLoading) {
  patchSlice("app", { loading: Boolean(isLoading) });
}

export function setAppSaving(isSaving) {
  patchSlice("app", { saving: Boolean(isSaving) });
}

export function setAppError(error) {
  patchSlice("app", {
    error: error ? String(error) : null,
  });
}

export function clearAppError() {
  patchSlice("app", { error: null });
}

/* ==========================================================================
   AUTH / SESSION
   ========================================================================== */

export function setAuthUser(user = null) {
  const normalizedUser = normalizeAuthUser(user);

  patchSlice("auth", {
    user: normalizedUser,
    ready: true,
    isAuthenticated: Boolean(normalizedUser?.uid),
  });
}

export function setAuthReady(isReady) {
  patchSlice("auth", { ready: Boolean(isReady) });
}

export function getAuthUser() {
  return clone(state.auth.user);
}

/* ==========================================================================
   SEARCH
   ========================================================================== */

export function setSearchQuery(query) {
  const safeQuery = query === null || query === undefined ? "" : String(query);

  patchSlice("search", {
    query: safeQuery,
    lastSearchAt: Date.now(),
  });
}

export function setSearchResults(results = []) {
  const { byId, allIds } = normalizeStudentList(results);

  const nextSelectedIds = (state.search.selectedStudentIds || []).filter((id) => byId[id]);

  patchState({
    students: {
      byId,
      allIds,
    },
    search: {
      filteredIds: safeQueryHasValue(state.search.query) ? allIds : [],
      selectedStudentIds: nextSelectedIds,
    },
  });
}

export function setFilteredResults(results = []) {
  const normalized = toArraySafe(results)
    .map(normalizeStudentRecord)
    .filter(Boolean);

  const byIdPatch = {};
  const filteredIds = [];

  normalized.forEach((student) => {
    byIdPatch[student.id] = {
      ...(state.students.byId[student.id] || {}),
      ...student,
    };
    filteredIds.push(student.id);
  });

  patchState({
    students: {
      byId: {
        ...state.students.byId,
        ...byIdPatch,
      },
      allIds: uniqueStrings([...state.students.allIds, ...Object.keys(byIdPatch)]),
    },
    search: {
      filteredIds,
    },
  });
}

export function setFilteredStudentIds(studentIds = []) {
  patchSlice("search", {
    filteredIds: uniqueStrings(studentIds),
  });
}

export function setSelectedStudentIds(studentIds = []) {
  const normalizedIds = uniqueStrings(studentIds).filter(
    (id) => Boolean(state.students.byId[id])
  );

  patchSlice("search", {
    selectedStudentIds: normalizedIds,
  });
}

export function addSelectedStudentId(studentId) {
  const safeId = toStringSafe(studentId);
  if (!safeId || !state.students.byId[safeId]) return;

  const current = state.search.selectedStudentIds || [];
  setSelectedStudentIds([...current, safeId]);
}

export function removeSelectedStudentId(studentId) {
  const safeId = toStringSafe(studentId);
  if (!safeId) return;

  const current = state.search.selectedStudentIds || [];
  setSelectedStudentIds(current.filter((id) => id !== safeId));
}

export function toggleSelectedStudentId(studentId) {
  const safeId = toStringSafe(studentId);
  if (!safeId || !state.students.byId[safeId]) return;

  const current = state.search.selectedStudentIds || [];
  if (current.includes(safeId)) {
    removeSelectedStudentId(safeId);
  } else {
    addSelectedStudentId(safeId);
  }
}

export function clearSelectedStudentIds() {
  setSelectedStudentIds([]);
}

/* ==========================================================================
   STUDENTS
   ========================================================================== */

export function setStudentsList(students = []) {
  const { byId, allIds } = normalizeStudentList(students);

  let nextCurrentStudentId = state.students.currentStudentId;
  if (nextCurrentStudentId && !byId[nextCurrentStudentId]) {
    nextCurrentStudentId = null;
  }

  const nextSelectedIds = (state.search.selectedStudentIds || []).filter((id) => byId[id]);

  patchState({
    students: {
      byId,
      allIds,
      currentStudentId: nextCurrentStudentId,
      loading: false,
    },
    search: {
      filteredIds: safeQueryHasValue(state.search.query) ? state.search.filteredIds : [],
      selectedStudentIds: nextSelectedIds,
    },
  });
}

export function upsertStudents(students = []) {
  const currentById = { ...state.students.byId };
  const currentIds = new Set(state.students.allIds);

  toArraySafe(students)
    .map(normalizeStudentRecord)
    .filter(Boolean)
    .forEach((student) => {
      currentById[student.id] = {
        ...(currentById[student.id] || {}),
        ...student,
      };
      currentIds.add(student.id);
    });

  patchSlice("students", {
    byId: currentById,
    allIds: sortStudentIdsByName(currentById, [...currentIds]),
  });
}

export function setCurrentStudentId(studentId) {
  const safeId = toStringSafe(studentId);
  const exists = safeId && state.students.byId[safeId];

  const nextId = exists ? safeId : null;
  const nextStudent = nextId ? state.students.byId[nextId] : null;

  patchState({
    students: {
      currentStudentId: nextId,
    },
  });

  if (nextId) {
    hydrateDraftForStudent(nextStudent, CONFIG.modes.individual);
  } else {
    resetDraft();
  }
}

export function setSelectedStudent(student) {
  const normalized = normalizeStudentRecord(student);

  if (!normalized) {
    setCurrentStudentId(null);
    return;
  }

  patchState({
    students: {
      byId: {
        ...state.students.byId,
        [normalized.id]: {
          ...(state.students.byId[normalized.id] || {}),
          ...normalized,
        },
      },
      allIds: sortStudentIdsByName(
        {
          ...state.students.byId,
          [normalized.id]: {
            ...(state.students.byId[normalized.id] || {}),
            ...normalized,
          },
        },
        [...new Set([...state.students.allIds, normalized.id])]
      ),
      currentStudentId: normalized.id,
    },
  });
  hydrateDraftForStudent(normalized, CONFIG.modes.individual);
}

export function updateStudentProfile(profile) {
  const normalizedProfile = normalizeProfileRecord(profile);
  if (!normalizedProfile) return;

  const profileId = normalizedProfile.id;
  const existingStudent = state.students.byId[profileId] || {};

  patchState({
    students: {
      byId: {
        ...state.students.byId,
        [profileId]: {
          ...existingStudent,
          ...normalizedProfile,
        },
      },
      allIds: sortStudentIdsByName(
        {
          ...state.students.byId,
          [profileId]: {
            ...existingStudent,
            ...normalizedProfile,
          },
        },
        [...new Set([...state.students.allIds, profileId])]
      ),
    },
    profile: {
      byStudentId: {
        ...state.profile.byStudentId,
        [profileId]: {
          ...(state.profile.byStudentId[profileId] || {}),
          ...normalizedProfile,
        },
      },
      error: null,
    },
  });
}

export function setStudentProfile(studentId, profile = {}) {
  const safeId = toStringSafe(studentId) || extractStudentId(profile);
  if (!safeId) return;

  updateStudentProfile({
    ...(profile || {}),
    id: safeId,
    studentId: safeId,
    studentKey: extractStudentKey(profile) || safeId,
  });
}

export function setStudentGoals(studentId, goals = []) {
  const safeId = toStringSafe(studentId);
  if (!safeId) return;

  const nextGoalsByStudentId = {
    ...state.profile.goalsByStudentId,
    [safeId]: toArraySafe(goals).map((goal) => ({
      ...goal,
      id: toStringSafe(goal?.id) || getRandomId("goal"),
      title: toStringSafe(goal?.title || goal?.titulo),
      status: toStringSafe(goal?.status || goal?.estado || "pendiente"),
      progress: Number.isFinite(Number(goal?.progress))
        ? Number(goal.progress)
        : Number.isFinite(Number(goal?.avance))
        ? Number(goal.avance)
        : 0,
      notes: toStringSafe(goal?.notes || goal?.notas),
      updatedAt: goal?.updatedAt || goal?.fechaActualizacion || null,
    })),
  };

  patchSlice("profile", {
    goalsByStudentId: nextGoalsByStudentId,
  });
}

export function setStudentRoute(studentId, route = {}) {
  const safeId = toStringSafe(studentId);
  if (!safeId) return;

  const nextRouteByStudentId = {
    ...state.profile.routeByStudentId,
    [safeId]: {
      ...(isPlainObject(route) ? route : {}),
      stage: toStringSafe(route?.stage || route?.etapa),
      milestones: Array.isArray(route?.milestones)
        ? [...route.milestones]
        : Array.isArray(route?.hitos)
        ? [...route.hitos]
        : [],
      recommendations: Array.isArray(route?.recommendations)
        ? [...route.recommendations]
        : Array.isArray(route?.recomendaciones)
        ? [...route.recomendaciones]
        : [],
    },
  };

  patchSlice("profile", {
    routeByStudentId: nextRouteByStudentId,
  });
}

export function setStudentsLoading(isLoading) {
  patchSlice("students", { loading: Boolean(isLoading) });
}

export function setProfileLoading(isLoading) {
  patchSlice("profile", { loading: Boolean(isLoading) });
}

export function setProfileError(error) {
  patchSlice("profile", {
    error: error ? String(error) : null,
  });
}

export function clearProfileError() {
  patchSlice("profile", { error: null });
}

/* ==========================================================================
   FILTERS
   ========================================================================== */

export function setFilters(filters = {}) {
  patchSlice("filters", {
    sede: toStringSafe(filters.sede ?? state.filters.sede),
    modalidad: toStringSafe(filters.modalidad ?? state.filters.modalidad),
    docente: toStringSafe(filters.docente ?? state.filters.docente),
    area: toStringSafe(filters.area ?? state.filters.area),
  });
}

export function resetFilters() {
  patchSlice("filters", clone(initialState.filters));
}

/* ==========================================================================
   BITÁCORAS
   ========================================================================== */

export function setBitacorasForStudent(studentId, items = []) {
  const safeStudentId = toStringSafe(studentId);
  if (!safeStudentId) return;

  const normalizedItems = sortBitacoras(
    toArraySafe(items).map(normalizeBitacoraItem).filter(Boolean)
  );

  const loadedIds = uniqueStrings([
    ...(state.bitacoras.loadedStudentIds || []),
    safeStudentId,
  ]);

  patchSlice("bitacoras", {
    byStudentId: {
      ...state.bitacoras.byStudentId,
      [safeStudentId]: normalizedItems,
    },
    loadedStudentId: safeStudentId,
    loadedStudentIds: loadedIds,
    error: null,
  });
}

export function addBitacoraForStudent(studentId, bitacora) {
  const safeStudentId = toStringSafe(studentId);
  const normalizedBitacora = normalizeBitacoraItem(bitacora);

  if (!safeStudentId || !normalizedBitacora) return;

  const current = state.bitacoras.byStudentId?.[safeStudentId] || [];
  const withoutDuplicate = current.filter(
    (item) => toStringSafe(item.id) !== normalizedBitacora.id
  );

  patchSlice("bitacoras", {
    byStudentId: {
      ...state.bitacoras.byStudentId,
      [safeStudentId]: sortBitacoras([normalizedBitacora, ...withoutDuplicate]),
    },
  });
}

export function setBitacorasLoading(isLoading) {
  patchSlice("bitacoras", { loading: Boolean(isLoading) });
}

export function setBitacorasSaving(isSaving) {
  patchSlice("bitacoras", { saving: Boolean(isSaving) });
}

export function setBitacorasError(error) {
  patchSlice("bitacoras", {
    error: error ? String(error) : null,
  });
}

export function clearBitacorasError() {
  patchSlice("bitacoras", { error: null });
}

export function setDraftMode(mode) {
  const normalizedMode = normalizeMode(mode);
  const currentDraft = getCurrentDraft();

  let nextDraft = {
    ...currentDraft,
    mode: normalizedMode,
    updatedAt: getNowIso(),
  };

  if (normalizedMode === CONFIG.modes.individual) {
    const primaryStudentId =
      toStringSafe(currentDraft.studentId) ||
      uniqueStrings(currentDraft.studentIds)[0] ||
      state.students.currentStudentId ||
      null;

    nextDraft = createEmptyDraft({
      ...nextDraft,
      mode: CONFIG.modes.individual,
      studentId: primaryStudentId,
      studentKey: primaryStudentId,
      studentIds: primaryStudentId ? [primaryStudentId] : [],
      studentRefs: primaryStudentId
        ? buildStudentRefsFromIds([primaryStudentId], state.students.byId)
        : [],
    });
  } else {
    const groupIds = uniqueStrings(
      currentDraft.studentIds?.length
        ? currentDraft.studentIds
        : state.search.selectedStudentIds || []
    );

    nextDraft = createEmptyDraft({
      ...nextDraft,
      mode: CONFIG.modes.group,
      studentId: null,
      studentKey: null,
      studentIds: groupIds,
      studentRefs: buildStudentRefsFromIds(groupIds, state.students.byId),
    });
  }

  updateDraft(nextDraft);
}

export function updateDraft(partialDraft = {}) {
  const merged = {
    ...state.bitacoras.currentDraft,
    ...partialDraft,
    updatedAt: getNowIso(),
  };

  let normalizedDraft = createEmptyDraft(merged);

  if (normalizedDraft.mode === CONFIG.modes.individual) {
    const fallbackStudentId =
      normalizedDraft.studentId ||
      state.students.currentStudentId ||
      uniqueStrings(state.search.selectedStudentIds)[0] ||
      null;

    normalizedDraft = createEmptyDraft({
      ...normalizedDraft,
      studentId: fallbackStudentId,
      studentKey: fallbackStudentId,
      studentIds: fallbackStudentId ? [fallbackStudentId] : [],
      studentRefs: fallbackStudentId
        ? buildStudentRefsFromIds([fallbackStudentId], state.students.byId)
        : [],
    });
  }

  if (normalizedDraft.mode === CONFIG.modes.group) {
    const groupIds = uniqueStrings(normalizedDraft.studentIds);
    normalizedDraft = createEmptyDraft({
      ...normalizedDraft,
      studentId: null,
      studentKey: null,
      studentIds: groupIds,
      studentRefs:
        normalizedDraft.studentRefs?.length
          ? normalizedDraft.studentRefs
          : buildStudentRefsFromIds(groupIds, state.students.byId),
    });
  }

  patchSlice("bitacoras", {
    currentDraft: normalizedDraft,
  });

  persistCurrentDraft(normalizedDraft);
}

export function resetDraft(overrides = {}) {
  const cleanDraft = createEmptyDraft(overrides);

  patchSlice("bitacoras", {
    currentDraft: cleanDraft,
  });

  removePersistedDraft(cleanDraft);
}

export function prepareIndividualDraft(studentId) {
  const safeId = toStringSafe(studentId) || state.students.currentStudentId;
  if (!safeId) {
    resetDraft({ mode: CONFIG.modes.individual });
    return;
  }

  const student = state.students.byId[safeId] || null;
  hydrateDraftForStudent(student, CONFIG.modes.individual);
}

export function prepareGroupDraft(studentIds = []) {
  const groupIds = uniqueStrings(studentIds).filter((id) => state.students.byId[id]);
  if (!groupIds.length) {
    resetDraft({ mode: CONFIG.modes.group });
    return;
  }

  const loadedDraft = loadGroupDraft(groupIds);
  if (loadedDraft) return loadedDraft;

  const draft = createEmptyDraft({
    mode: CONFIG.modes.group,
    studentIds: groupIds,
    studentRefs: buildStudentRefsFromIds(groupIds, state.students.byId),
  });

  patchSlice("bitacoras", {
    currentDraft: draft,
  });

  persistCurrentDraft(draft);

  return draft;
}

export function loadDraft(studentId, mode = CONFIG.modes.individual) {
  const safeStudentId = toStringSafe(studentId);
  if (!safeStudentId) return null;
  return null;
}

export function loadGroupDraft(studentIds = []) {
  const groupIds = uniqueStrings(studentIds);
  if (!groupIds.length) return null;
  return null;
}

export function hydrateDraftForStudent(student, mode = CONFIG.modes.individual) {
  const normalizedStudent = normalizeStudentRecord(student);
  if (!normalizedStudent) {
    resetDraft({ mode: normalizeMode(mode) });
    return;
  }

  const studentId = normalizedStudent.id;
  const normalizedMode = normalizeMode(mode);

  if (normalizedMode === CONFIG.modes.group) {
    prepareGroupDraft([studentId]);
    return;
  }

  const loadedDraft = loadDraft(studentId, normalizedMode);
  if (loadedDraft) return loadedDraft;

  const baseDraft = createEmptyDraft({
    mode: CONFIG.modes.individual,
    studentId,
    studentKey: normalizedStudent.studentKey || studentId,
    studentIds: [studentId],
    studentRefs: [
      {
        id: studentId,
        name: extractStudentName(normalizedStudent),
      },
    ],
  });

  patchSlice("bitacoras", {
    currentDraft: baseDraft,
  });

  persistCurrentDraft(baseDraft);

  return baseDraft;
}

export function getCurrentDraft() {
  return clone(state.bitacoras.currentDraft);
}

export function getSelectedStudentBitacoras() {
  const studentId = getSelectedStudentId();
  if (!studentId) return [];
  return clone(state.bitacoras.byStudentId?.[studentId] || []);
}

/* ==========================================================================
   UPLOADS
   ========================================================================== */

export function setUploadQueue(files = []) {
  patchSlice("uploads", {
    queue: Array.isArray(files) ? [...files] : [],
  });
}

export function addUploadedFiles(files = []) {
  const current = state.uploads.uploaded || [];

  patchSlice("uploads", {
    uploaded: [...current, ...toArraySafe(files)],
  });
}

export function clearUploads() {
  patchSlice("uploads", {
    queue: [],
    uploaded: [],
    uploading: false,
  });
}

export function setUploading(isUploading) {
  patchSlice("uploads", { uploading: Boolean(isUploading) });
}

/* ==========================================================================
   UI
   ========================================================================== */

export function openModal(modalName, data = null) {
  patchSlice("ui", {
    modal: {
      name: modalName,
      data,
    },
  });
}

export function closeModal() {
  patchSlice("ui", { modal: null });
}

export function toggleSidebar(forceValue = null) {
  const next =
    typeof forceValue === "boolean" ? forceValue : !state.ui.sidebarOpen;

  patchSlice("ui", { sidebarOpen: next });
}

export function addToast(toast) {
  const id = getRandomId("toast");

  const nextToast = {
    id,
    type: toast?.type || "info",
    message: toast?.message || "",
    duration: toast?.duration || 3000,
  };

  patchSlice("ui", {
    toasts: [...state.ui.toasts, nextToast],
  });

  return id;
}

export function removeToast(toastId) {
  patchSlice("ui", {
    toasts: state.ui.toasts.filter((toast) => toast.id !== toastId),
  });
}

/* ==========================================================================
   HYDRATION
   ========================================================================== */

export function hydrateStateFromStorage() {
  clearLegacyLocalState();

  state = finalizeState({
    ...clone(initialState),
    app: {
      ...clone(initialState.app),
      currentView: safeRoute(CONFIG.app.defaultRoute),
    },
  });

  notify();
}

/* ==========================================================================
   SELECTORS
   ========================================================================== */

export function getSelectedStudentId() {
  return toStringSafe(state.students.currentStudentId) || null;
}

export function getSelectedStudentIds() {
  return clone(state.search.selectedStudentIds || []);
}

export function getCurrentStudent() {
  const currentId = getSelectedStudentId();
  if (!currentId) return null;
  return clone(state.students.byId[currentId] || null);
}

export function getStudentById(studentId) {
  const safeId = toStringSafe(studentId);
  if (!safeId) return null;
  return clone(state.students.byId[safeId] || null);
}

export function getAllStudents() {
  return clone(state.students.allIds.map((id) => state.students.byId[id]).filter(Boolean));
}

export function getFilteredStudents() {
  return clone(state.search.filteredResults || []);
}

export function getCurrentStudentProfile() {
  const currentId = getSelectedStudentId();
  if (!currentId) return null;

  const student = state.students.byId[currentId] || null;
  const profile = state.profile.byStudentId[currentId] || null;

  if (!student && !profile) return null;

  return clone({
    ...(student || {}),
    ...(profile || {}),
    goals: state.profile.goalsByStudentId[currentId] || [],
    route: state.profile.routeByStudentId[currentId] || {},
  });
}

export function getStudentProfileById(studentId) {
  const safeId = toStringSafe(studentId);
  if (!safeId) return null;

  const student = state.students.byId[safeId] || null;
  const profile = state.profile.byStudentId[safeId] || null;

  if (!student && !profile) return null;

  return clone({
    ...(student || {}),
    ...(profile || {}),
    goals: state.profile.goalsByStudentId[safeId] || [],
    route: state.profile.routeByStudentId[safeId] || {},
  });
}

export function getStudentGoals(studentId) {
  const safeId = toStringSafe(studentId);
  if (!safeId) return [];
  return clone(state.profile.goalsByStudentId[safeId] || []);
}

export function getStudentRoute(studentId) {
  const safeId = toStringSafe(studentId);
  if (!safeId) return {};
  return clone(state.profile.routeByStudentId[safeId] || {});
}

export function isStudentLoaded(studentId) {
  const safeId = toStringSafe(studentId);
  if (!safeId) return false;
  return (state.bitacoras.loadedStudentIds || []).includes(safeId);
}

/* ==========================================================================
   PERSISTENCIA DE DRAFTS
   ========================================================================== */

function getDraftStorageKey(draft) {
  const mode = normalizeMode(draft?.mode);
  const studentId = toStringSafe(draft?.studentId);
  const studentIds = uniqueStrings(draft?.studentIds);

  if (mode === CONFIG.modes.group) {
    if (!studentIds.length) return null;
    return buildGroupDraftKey(studentIds);
  }

  if (!studentId) return null;
  return buildDraftKey(studentId, mode);
}

function persistCurrentDraft(draft) {
  void draft;
}

function removePersistedDraft(draft) {
  void draft;
}

/* ==========================================================================
   STORAGE SAFETY
   ========================================================================== */

function safeLocalStorageGet(key) {
  void key;
  return null;
}

function safeLocalStorageSet(key, value) {
  void key;
  void value;
}

function safeLocalStorageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.warn(`No se pudo eliminar "${key}" de localStorage:`, error);
  }
}

function clearLegacyLocalState() {
  try {
    const knownKeys = new Set(
      Object.values(CONFIG.storage || {})
        .map((key) => toStringSafe(key))
        .filter(Boolean)
    );
    const draftPrefix = toStringSafe(CONFIG.storage?.draftPrefix);
    const groupDraftPrefix = toStringSafe(CONFIG.storage?.groupDraftPrefix);

    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = toStringSafe(localStorage.key(index));
      if (!key) continue;

      if (
        knownKeys.has(key) ||
        (draftPrefix && key.startsWith(draftPrefix)) ||
        (groupDraftPrefix && key.startsWith(groupDraftPrefix))
      ) {
        localStorage.removeItem(key);
      }
    }
  } catch (error) {
    console.warn("No se pudo limpiar el estado local heredado:", error);
  }
}

/* ==========================================================================
   UTILS INTERNOS
   ========================================================================== */

function safeQueryHasValue(query) {
  return Boolean(toStringSafe(query));
}

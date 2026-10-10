import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

function load(context, file) {
  const source = fs.readFileSync(new URL(file, import.meta.url), "utf8")
    .replace(/^import[\s\S]*?from\s*["'][^"']+["'];\s*/gm, "")
    .replace(/^export default[\s\S]*$/m, "")
    .replace(/^export\s*\{[\s\S]*?\};\s*/gm, "")
    .replace(/^export /gm, "");
  vm.runInContext(source, context);
}

const historical = {
  id: "stu_felipe_prueba", studentKey: "stu_felipe_prueba", nombre: "Felipe Gómez Iregui",
  estado: "Inactivo", correo: "familiar@example.invalid",
  processes: [{ arte: "Música", detalle: "Iniciación", label: "Música - Iniciación" }],
};

function apiHarness() {
  const context = vm.createContext({
    CONFIG: { api: {}, roles: { admin: "admin", teacher: "teacher" } },
    getStudentsCollectionName: () => "students", db: {},
    normalizeTimestamps: (value) => value,
    collection: () => "students",
    getDocs: async () => ({ docs: [{ id: historical.id, data: () => historical }] }),
    listStudentIdentityLinkRecords: async () => [],
  });
  load(context, "../js/utils/shared.js");
  load(context, "../js/utils/student-search.js");
  load(context, "../js/utils/student-resolver.js");
  load(context, "../js/api/students.api.js");
  return context;
}

function viewHarness({ query = "felipe iregui", getStudents } = {}) {
  const state = {
    auth: { user: { role: "admin" } },
    students: { allIds: [], byId: {}, ready: true, loading: false },
    search: { query, results: [], filteredIds: [], filteredResults: [] },
  };
  const filterState = () => { state.search.filteredResults = state.search.filteredIds.map((id) => state.students.byId[id]).filter(Boolean); };
  const setList = (students) => {
    state.students.allIds = students.map((student) => student.id);
    state.students.byId = Object.fromEntries(students.map((student) => [student.id, student]));
    filterState();
  };
  const context = vm.createContext({
    CONFIG: { roles: { admin: "admin", teacher: "teacher" } },
    console: { warn() {}, error() {} },
    getState: () => state,
    resolveUserAccess: () => ({ role: "admin" }),
    clearAppError: () => {}, setAppError: (error) => { state.error = error; },
    setStudentsLoading: (loading) => { state.students.loading = loading; },
    setSearchResults: (students) => { state.search.results = students; },
    setStudentsList: setList,
    setFilteredStudentIds: (ids) => { state.search.filteredIds = ids; filterState(); },
    patchSlice: (slice, patch) => { Object.assign(state[slice], patch); filterState(); },
    setSelectedStudent: (student) => { state.students.selected = student; },
    getTeacherListStudents: async () => [],
    getStudents: getStudents || ((options) => apiHarness().getStudents(options)),
  });
  load(context, "../js/utils/shared.js");
  load(context, "../js/utils/student-search.js");
  load(context, "../js/views/search.view.js");
  return { context, state };
}

test("La API histórica encuentra nombres abreviados, invertidos y con tildes", async () => {
  const api = apiHarness();
  for (const q of ["felipe iregui", "Iregui Felipe", "  FELIPE   GÓMEZ  ", "felipe iniciacion"]) {
    assert.equal((await api.getStudents({ q, includeInactive: true })).length, 1, q);
  }
  assert.equal((await api.getStudents({ q: "santiago iregui", includeInactive: true })).length, 0);
  assert.equal((await api.getStudents({ q: "felipe inexistente", includeInactive: true })).length, 0);
  assert.equal((await api.getStudents({ q: "felipe iregui", includeInactive: false })).length, 0);
});

test("La lista local y el histórico aplican el mismo criterio, incluidos procesos e IDs", () => {
  const api = apiHarness();
  const { context } = viewHarness();
  for (const q of ["felipe iregui", "iregui felipe", "felipe iniciacion", "stu_felipe_prueba", "santiago iregui"]) {
    assert.equal(context.filterStudents([historical], q).length > 0, api.matchesStudentQuery(historical, q), q);
  }
});

test("Recargar conserva la consulta y recupera el histórico en cada intento", async () => {
  const { context, state } = viewHarness();
  for (let attempt = 0; attempt < 2; attempt++) {
    await context.refreshStudents({}, { refresh: true });
    assert.equal(state.search.query, "felipe iregui");
    assert.equal(state.search.filteredResults[0]?.id, historical.id);
    assert.equal(state.students.loading, false);
  }
});

test("Volver a Búsqueda con una consulta guardada también recupera el histórico", async () => {
  const { context, state } = viewHarness();
  const other = { id: "otro", nombre: "Otra estudiante" };
  state.students.allIds = [other.id];
  state.students.byId = { [other.id]: other };
  await context.ensureStudentsLoaded();
  assert.equal(state.search.filteredResults[0]?.id, historical.id);
});

test("Espacios al final de la consulta no descartan la respuesta histórica", async () => {
  const { context, state } = viewHarness({ query: "felipe iregui  " });
  await context.appendInactiveMatches(state.search.query, []);
  assert.equal(state.search.filteredResults[0]?.id, historical.id);
});

test("Una respuesta antigua no reemplaza una búsqueda más reciente", async () => {
  let finish;
  const { context, state } = viewHarness({ getStudents: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = context.appendInactiveMatches(state.search.query, []);
  state.search.query = "otra";
  await context.appendInactiveMatches("otra", [{ id: "otra", nombre: "Otra estudiante" }]);
  state.search.query = "felipe iregui";
  finish([historical]);
  await pending;
  assert.equal(state.search.results.length, 0);
});

test("Un error histórico se muestra y Recargar permite reintentar", async () => {
  let fail = true;
  const { context, state } = viewHarness({ getStudents: async () => {
    if (fail) throw new Error("permission-denied");
    return [historical];
  } });
  await context.appendInactiveMatches(state.search.query, []);
  assert.match(context.renderEmptyResultsState(state), /No se pudo completar la búsqueda/);
  assert.match(context.renderEmptyResultsState(state), /Recargar/);
  fail = false;
  await context.refreshStudents({}, { refresh: true });
  assert.equal(state.search.filteredResults[0]?.id, historical.id);
});

test("La búsqueda pendiente se distingue de una consulta terminada sin coincidencias", async () => {
  let finish;
  const { context, state } = viewHarness({ getStudents: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = context.appendInactiveMatches(state.search.query, []);
  assert.match(context.renderEmptyResultsState(state), /Buscando otros expedientes/);
  finish([]);
  await pending;
  assert.match(context.renderEmptyResultsState(state), /Sin resultados/);
});

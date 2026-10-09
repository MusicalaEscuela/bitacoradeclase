import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { ProfileSaveFeedback, profileSaveErrorMessage } from "../js/ui/profile-save.ui.js";
import { getBitacoraParticipantIds } from "../js/utils/bitacora-coverage.js";

const song = { nombre: "Canción de prueba", estado: "quiere", prioridad: "media", notas: "", fechaInicio: "", fechaLogro: "" };
const user = { uid: "docente-actual", email: "actual@example.invalid", name: "Docente actual" };
const original = { uid: "docente-original", email: "original@example.invalid", name: "Docente original" };
let passed = 0;
async function test(name, fn) { await fn(); console.log(`OK ${name}`); passed++; }

function apiContext(file, initial = {}) {
  const records = structuredClone(initial);
  const calls = { writes: [], reads: [] };
  const snapshot = (id) => ({ id: id.split("/").pop(), exists: () => Boolean(records[id]), data: () => records[id] });
  const context = {
    CONFIG: { api: {}, limits: { maxBitacoraLength: 5000, maxTitleLength: 140 }, modes: { individual: "individual", group: "group" }, text: {} },
    getStudentsCollectionName: () => "students", getBitacorasCollectionName: () => "bitacoras",
    canUseFirestoreBitacoras: () => true, assertValidBitacoraMode: (mode) => mode,
    db: {}, doc: (_, collection, id) => `${collection}/${id}`,
    getCurrentUser: () => user, getApiUrl: () => "",
    isPlainObject: (value) => value != null && typeof value === "object" && !Array.isArray(value),
    normalizeText: (value) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase(),
    toStringSafe: (value) => String(value ?? "").trim(),
    uniqueStrings: (values) => [...new Set((values || []).map((x) => String(x ?? "").trim()).filter(Boolean))],
    normalizeLocalDateInput: (value) => String(value || "").slice(0, 10),
    getTimestamp: (value) => value ? new Date(value).getTime() : 0,
    normalizeTimestamps: (value) => value, serverTimestamp: () => "2026-10-09T12:00:00Z",
    getBitacoraParticipantIds,
    getDoc: async (id) => snapshot(id),
    getDocFromServer: async (id) => { calls.reads.push(id); return snapshot(id); },
    updateDoc: async (id, data) => { calls.writes.push(id); records[id] = { ...records[id], ...data }; },
    writeBatch: () => { const pending = []; return { update: (id, data) => pending.push([id, data]), commit: async () => {
      if (pending.some(([id]) => !records[id])) throw Object.assign(new Error("Missing alias"), { code: "not-found" });
      for (const [id, data] of pending) { calls.writes.push(id); records[id] = { ...records[id], ...data }; }
    } }; },
    runTransaction: async (_, fn) => fn({ get: async (id) => snapshot(id), update: (id, data) => { calls.writes.push(id); records[id] = { ...records[id], ...data }; } }),
    console,
  };
  vm.createContext(context);
  let source = fs.readFileSync(new URL(file, import.meta.url), "utf8")
    .replace(/^import[\s\S]*?from\s*["'][^"']+["'];\s*/gm, "")
    .replace(/^export default[\s\S]*$/m, "")
    .replace(/^export\s*\{[\s\S]*?\};\s*/gm, "")
    .replace(/^export /gm, "");
  vm.runInContext(source, context);
  return { context, records, calls };
}

await test("repertorio se confirma con lectura del servidor", async () => {
  const { context, records, calls } = apiContext("../js/api/students.api.js", { "students/estudiante": {} });
  const result = await context.updateStudentRepertoire("estudiante", [song]);
  assert.equal(result.repertorioProceso[0].nombre, song.nombre);
  assert.deepEqual(calls.reads, ["students/estudiante"]);
  assert.equal(records["students/estudiante"].updatedBy, "profile_repertoire");
});
await test("alias y canónico deben confirmar ambos el repertorio", async () => {
  const { context, calls } = apiContext("../js/api/students.api.js", { "students/alias": { canonicalStudentId: "canonico" }, "students/canonico": {} });
  await context.updateStudentRepertoire("alias", [song]);
  assert.deepEqual(calls.reads.sort(), ["students/alias", "students/canonico"]);
});
await test("un rechazo del batch no informa éxito ni guarda parcialmente", async () => {
  const { context, calls } = apiContext("../js/api/students.api.js", { "students/alias": { canonicalStudentId: "ausente" } });
  await assert.rejects(context.updateStudentRepertoire("alias", [song]), { code: "not-found" });
  assert.equal(calls.writes.length, 0);
});
await test("lectura discrepante o sin red no se presenta como éxito", async () => {
  for (const fail of [false, true]) {
    const { context } = apiContext("../js/api/students.api.js", { "students/estudiante": {} });
    context.getDocFromServer = async () => { if (fail) throw new Error("Sin conexión"); return { exists: () => true, data: () => ({}) }; };
    await assert.rejects(context.updateStudentRepertoire("estudiante", [song]), { code: "REPERTOIRE_CONFIRMATION_FAILED" });
  }
});
await test("máximo de 20 canciones se valida antes de escribir", async () => {
  const { context, calls } = apiContext("../js/api/students.api.js", { "students/estudiante": {} });
  await assert.rejects(context.updateStudentRepertoire("estudiante", Array.from({ length: 21 }, (_, i) => ({ ...song, nombre: `Canción ${i}` }))), { code: "REPERTOIRE_TOO_LARGE" });
  assert.equal(calls.writes.length, 0);
});

const log = { mode: "group", title: "Clase grupal", content: "Trabajo de clase", studentIds: ["ana", "luis"], primaryStudentId: "ana", author: original, fechaClase: "2026-09-25", updatedAt: "2026-10-09T10:00:00Z", studentOverrides: { ana: { processKey: "piano" }, luis: { processKey: "guitarra" } } };
await test("cambiar proceso conserva el autor y los otros integrantes", async () => {
  const { context, records } = apiContext("../js/api/bitacoras.api.js", { "bitacoras/clase": log });
  await context.updateBitacora("clase", { studentOverrides: { ...log.studentOverrides, ana: { processKey: "bateria" } } }, { preserveAuthor: true, expectedUpdatedAt: new Date(log.updatedAt).getTime() });
  assert.equal(records["bitacoras/clase"].author.uid, original.uid);
  assert.equal(records["bitacoras/clase"].teacherEmail, original.email);
  assert.equal(records["bitacoras/clase"].studentOverrides.luis.processKey, "guitarra");
});
await test("edición simultánea detiene el cambio sin pisar lo guardado", async () => {
  const { context, calls } = apiContext("../js/api/bitacoras.api.js", { "bitacoras/clase": log });
  await assert.rejects(context.updateBitacora("clase", { process: { processKey: "bateria" } }, { preserveAuthor: true, expectedUpdatedAt: 1 }), { code: "BITACORA_CONFLICT" });
  assert.equal(calls.writes.length, 0);
});
await test("consulta de confirmación de bitácora usa servidor", async () => {
  const { context, calls } = apiContext("../js/api/bitacoras.api.js", { "bitacoras/clase": log });
  await context.getBitacoraById("clase", { fromServer: true });
  assert.deepEqual(calls.reads, ["bitacoras/clase"]);
});
await test("clics repetidos se bloquean y el error permite reintento", async () => {
  const feedback = new ProfileSaveFeedback();
  assert.equal(feedback.begin("ana", "repertoire"), true);
  assert.equal(feedback.begin("ana", "repertoire"), false);
  assert.equal(feedback.begin("luis", "repertoire"), true);
  feedback.finish("ana", "repertoire", "error", "Sin red");
  assert.equal(feedback.begin("ana", "repertoire"), true);
  assert.match(profileSaveErrorMessage({ code: "PROCESS_CONFIRMATION_FAILED" }), /Recarga/);
});
function assignmentContext({ mismatch = false, rejectWrite = false } = {}) {
  let stored = structuredClone(log);
  const errors = [], successes = [];
  const context = {
    profileSaveFeedback: new ProfileSaveFeedback(), refreshProfileSaveFeedback() {},
    getStudentIdentity: (student) => student.id, clearAppError() {}, assertProfileOnline() {},
    getBitacoraById: async (_, options) => {
      assert.equal(options.fromServer, true);
      return mismatch && stored.metadata?.manualProcessAssignment ? { ...stored, studentOverrides: log.studentOverrides } : stored;
    },
    toStringSafe: (value) => String(value ?? "").trim(),
    normalizeStudentProcesses: () => [{ processKey: "bateria", arte: "Música", detalle: "Batería" }],
    resolveStudentProcess: () => ({ processKey: "bateria", arte: "Música", detalle: "Batería" }),
    firstNonEmpty: (...values) => values.find(Boolean) || "",
    normalizeHistoryClassTime: (value) => /^\d{2}:\d{2}$/.test(value) ? value : "",
    isGroupBitacora: () => true, resolveStudentOverrideKey: (_, student) => student.id,
    getTimestamp: (value) => new Date(value).getTime(),
    updateBitacora: async (_, patch, options) => {
      assert.equal(options.preserveAuthor, true);
      assert.equal(options.expectedUpdatedAt, new Date(log.updatedAt).getTime());
      if (rejectWrite) throw Object.assign(new Error("Rechazado"), { code: "permission-denied" });
      stored = { ...stored, ...patch };
    },
    reloadHistory: async () => {}, renderReactiveBlocks() {}, getState: () => ({}), CONFIG: {}, currentProfileStudentKey: "ana",
    showSuccess: (message) => successes.push(message), showError() {}, setAppError: (message) => errors.push(message),
    profileSaveErrorMessage, console: { error() {} },
  };
  const source = fs.readFileSync(new URL("../js/views/profile.view.js", import.meta.url), "utf8");
  const start = source.indexOf("async function assignProcessToBitacora(");
  const end = source.indexOf("function resolveStudentOverrideKey(", start);
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  return { context, errors, successes, stored: () => stored };
}
await test("flujo grupal confirma el proceso específico sin alterar a otros", async () => {
  const fixture = assignmentContext();
  await fixture.context.assignProcessToBitacora({ id: "ana" }, "clase", "bateria", "11:00");
  assert.equal(fixture.successes.length, 1);
  assert.equal(fixture.stored().studentOverrides.ana.processKey, "bateria");
  assert.equal(fixture.stored().studentOverrides.luis.processKey, "guitarra");
});
await test("flujo de proceso no muestra éxito si servidor devuelve otro proceso", async () => {
  const fixture = assignmentContext({ mismatch: true });
  await fixture.context.assignProcessToBitacora({ id: "ana" }, "clase", "bateria", "11:00");
  assert.equal(fixture.successes.length, 0);
  assert.match(fixture.errors[0], /Firebase recibió.*Recarga/);
});
await test("flujo de proceso comunica rechazo y habilita reintento", async () => {
  const fixture = assignmentContext({ rejectWrite: true });
  await fixture.context.assignProcessToBitacora({ id: "ana" }, "clase", "bateria", "11:00");
  assert.equal(fixture.successes.length, 0);
  assert.match(fixture.errors[0], /rechazó/);
  assert.equal(fixture.context.profileSaveFeedback.begin("ana", "process:clase"), true);
});
console.log(`${passed} pruebas de guardado aprobadas.`);

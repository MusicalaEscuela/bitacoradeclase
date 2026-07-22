"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Las pruebas de apply usan dobles de escritura; producción conserva el
// interruptor apagado salvo habilitación operativa explícita.
process.env.BACKFILL_APPLY_ENABLED = "true";

const {
  BackfillRequestError,
  validateBackfillRequestBody,
  backfillPatchDiff,
  buildBackfillPlanHash,
  publicBackfillPlan,
  minimalBitacorasIdentityPatch,
  minimalRipIdentityPatch,
  minimalUserIdentityPatch,
  userDocId,
  executeSafeBackfill,
  safeBackfillErrorCode,
  maskTechnicalId,
} = require("../index.js")._internals;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof BackfillRequestError && error.code === code);
}
function request(overrides = {}) {
  return {
    mode: "dryRun",
    runId: "backfill-test-01",
    studentIds: ["student-1"],
    ...overrides,
  };
}
function emptyPlan(mode = "dryRun", runId = "backfill-test-01", planHash = "a".repeat(64)) {
  return {
    mode,
    runId,
    requestedStudentIds: ["student-1"],
    eligibilityContextVersion: "context-v1",
    planHash,
    students: [{
      sourceDocId: "student-1",
      sourceVersion: "v1",
      eligible: true,
      action: "no_op",
      codes: [],
      reads: [{ destination: "source_student", version: "v1" }],
      writes: [],
    }],
  };
}
function normalizedFixture() {
  return {
    studentId: "student-1",
    sourceDocId: "student-1",
    studentIds: ["student-1"],
    documentValues: new Set(),
    contactId: "contact-1",
    nombre: "Test Name",
    name: "Test Name",
    normalizedName: "test name",
    email: "test@example.invalid",
    emails: ["test@example.invalid"],
  };
}

const snapshotTest = {};
function runPowerShell(script, args) {
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args,
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`POWERSHELL_FIXTURE_FAILED:${String(result.stderr || "").replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 200)}`);
  }
  const lines = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}
function runPowerShellFailure(script, args, expectedCode) {
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args,
  ], { encoding: "utf8" });
  assert.notStrictEqual(result.status, 0);
  assert.ok(`${result.stdout || ""}\n${result.stderr || ""}`.includes(expectedCode));
}
function validSnapshotPayload(count = 2) {
  return {
    schemaVersion: 2,
    runId: "fixture-run",
    createdAt: "2026-07-12T00:00:00.000Z",
    documents: Array.from({ length: count }, (_, index) => ({
      existedBefore: index % 2 === 0,
      content: index % 2 === 0 ? {
        name: `projects/test-project/databases/(default)/documents/students/student-${index}`,
        fields: { value: { stringValue: `before-${index}` } },
      } : null,
      updateTime: index % 2 === 0 ? `2026-07-12T00:00:${String(index).padStart(2, "0")}.000Z` : null,
      project: "test-project",
      path: `students/student-${index}`,
    })),
  };
}

test("rechaza ejecución sin studentIds", () => {
  expectCode(() => validateBackfillRequestBody(request({ studentIds: undefined })), "STUDENT_IDS_REQUIRED");
});

test("rechaza más de diez studentIds", () => {
  expectCode(() => validateBackfillRequestBody(request({ studentIds: Array.from({ length: 11 }, (_, i) => `s-${i}`) })), "TOO_MANY_STUDENT_IDS");
});

test("rechaza IDs duplicados, vacíos, con slash y query legacy", () => {
  expectCode(() => validateBackfillRequestBody(request({ studentIds: ["s-1", "s-1"] })), "DUPLICATE_STUDENT_IDS");
  expectCode(() => validateBackfillRequestBody(request({ studentIds: [""] })), "INVALID_STUDENT_ID");
  expectCode(() => validateBackfillRequestBody(request({ studentIds: ["a/b"] })), "INVALID_STUDENT_ID");
  expectCode(() => validateBackfillRequestBody(request(), { limit: "10" }), "QUERY_PARAMETERS_NOT_ALLOWED");
});

test("mode predeterminado es dryRun", () => {
  assert.strictEqual(validateBackfillRequestBody(request({ mode: undefined })).mode, "dryRun");
});

test("dryRun hace cero escrituras", async () => {
  let applyCalls = 0;
  const result = await executeSafeBackfill({
    body: request(),
    query: {},
    buildPlan: async () => emptyPlan(),
    applyPlan: async () => { applyCalls += 1; return 1; },
  });
  assert.strictEqual(result.mode, "dryRun");
  assert.strictEqual(applyCalls, 0);
  assert.strictEqual(result.counts.proposedWrites, 0);
});

test("apply exige confirmación y planHash", () => {
  expectCode(() => validateBackfillRequestBody(request({ mode: "apply", planHash: "a".repeat(64) })), "APPLY_CONFIRMATION_REQUIRED");
  expectCode(() => validateBackfillRequestBody(request({ mode: "apply", confirmApply: "APPLY_EXPLICIT_STUDENT_IDS" })), "PLAN_HASH_REQUIRED");
  expectCode(() => validateBackfillRequestBody(request({
    mode: "apply", confirmApply: "APPLY_EXPLICIT_STUDENT_IDS", planHash: "a".repeat(64),
  })), "SNAPSHOT_HASH_REQUIRED");
});

test("apply solo recibe IDs explícitos y detecta PLAN_STALE antes de escribir", async () => {
  let applyCalls = 0;
  await assert.rejects(
    executeSafeBackfill({
      body: request({
        mode: "apply",
        confirmApply: "APPLY_EXPLICIT_STUDENT_IDS",
        planHash: "b".repeat(64),
        snapshotHash: "c".repeat(64),
      }),
      query: {},
      buildPlan: async (validated) => {
        assert.deepStrictEqual(validated.studentIds, ["student-1"]);
        return emptyPlan("apply", validated.runId, "a".repeat(64));
      },
      applyPlan: async () => { applyCalls += 1; return 1; },
    }),
    (error) => error.code === "PLAN_STALE"
  );
  assert.strictEqual(applyCalls, 0);
});

test("parche users conserva estado, rol, permisos y acceso", () => {
  const existing = {
    active: false,
    status: "blocked",
    studentStatus: "paused",
    statusSource: "rip-musicala",
    role: "guardian",
    permissions: { admin: false },
    access: { hub: false },
    studentIds: ["legacy"],
  };
  const patch = minimalUserIdentityPatch(normalizedFixture(), existing, "test@example.invalid");
  for (const protectedField of ["active", "status", "studentStatus", "statusSource", "role", "permissions", "access"]) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(patch, protectedField), false);
  }
  assert.deepStrictEqual(existing, {
    active: false, status: "blocked", studentStatus: "paused", statusSource: "rip-musicala",
    role: "guardian", permissions: { admin: false }, access: { hub: false }, studentIds: ["legacy"],
  });
});

test("apply dirigido escribe studentId canónico y el dry-run posterior queda no_op", async () => {
  let state = { studentId: "legacy-id", studentIds: ["legacy-id"] };
  const normalized = normalizedFixture();
  const buildPlan = async ({ mode, runId }) => {
    const patch = minimalUserIdentityPatch(normalized, state, "test@example.invalid");
    const write = {
      project: "bitacoras", collection: "users", docId: "test@example.invalid",
      destination: "bitacoras_user", version: "v1", patch,
      diff: backfillPatchDiff(state, patch),
    };
    const plan = {
      mode, operation: "backfill", runId,
      requestedStudentIds: ["student-1"], eligibilityContextVersion: "context-v1",
      students: [{
        sourceDocId: "student-1", sourceVersion: "v1", eligible: true,
        action: write.diff.material ? "merge" : "no_op", codes: [],
        reads: [{ destination: "bitacoras_user", version: "v1" }], writes: [write],
      }],
    };
    plan.planHash = buildBackfillPlanHash(plan);
    return plan;
  };
  const initial = await buildPlan({ mode: "apply", runId: "repair-test" });
  const applied = await executeSafeBackfill({
    body: request({
      mode: "apply", runId: "repair-test", confirmApply: "APPLY_EXPLICIT_STUDENT_IDS",
      planHash: initial.planHash, snapshotHash: "c".repeat(64),
    }),
    query: {}, buildPlan,
    applyPlan: async (plan) => {
      state = { ...state, ...plan.students[0].writes[0].patch };
      return 1;
    },
  });
  assert.strictEqual(applied.appliedWrites, 1);
  assert.strictEqual(state.studentId, "student-1");
  const post = await executeSafeBackfill({
    body: request({ runId: "repair-test" }), query: {}, buildPlan,
  });
  assert.strictEqual(post.counts.noOp, 1);
  assert.strictEqual(post.counts.proposedWrites, 0);
});

test("backfill de user conserva updatedAt byte por byte", () => {
  const before = "2026-07-11T16:20:23.730Z";
  const existing = { studentId: "legacy", studentIds: ["legacy"], updatedAt: before };
  const patch = minimalUserIdentityPatch(normalizedFixture(), existing, "test@example.invalid");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(patch, "updatedAt"), false);
  assert.strictEqual(({ ...existing, ...patch }).updatedAt, before);
});

test("studentIds incluye el canónico exactamente una vez", () => {
  const patch = minimalUserIdentityPatch(
    normalizedFixture(),
    { studentId: "legacy", studentIds: ["student-1", "legacy", "student-1"] },
    "test@example.invalid"
  );
  assert.strictEqual(patch.studentIds.filter((id) => id === "student-1").length, 1);
});

test("correo con mayúsculas resuelve el mismo user document", () => {
  assert.strictEqual(userDocId(" Test@Example.Invalid "), "test@example.invalid");
  assert.strictEqual(userDocId("test@example.invalid"), "test@example.invalid");
});

test("user con ID legacy conserva todos sus campos de acceso", () => {
  const existing = {
    studentId: "legacy", studentIds: ["legacy"], active: false, role: "guardian",
    studentStatus: "paused", status: "blocked", statusSource: "rip-musicala",
    permissions: { reports: true }, access: { hub: false },
  };
  const patch = minimalUserIdentityPatch(normalizedFixture(), existing, "test@example.invalid");
  const after = { ...existing, ...patch };
  for (const field of ["active", "role", "studentStatus", "status", "statusSource", "permissions", "access"]) {
    assert.deepStrictEqual(after[field], existing[field]);
  }
});

test("sobrescritura posterior de studentId se detecta como diferencia material", () => {
  const canonical = minimalUserIdentityPatch(normalizedFixture(), {}, "test@example.invalid");
  const overwritten = { ...canonical, studentId: "legacy-id" };
  const diff = backfillPatchDiff(overwritten, canonical);
  assert.strictEqual(diff.material, true);
  assert.deepStrictEqual(diff.changed, ["studentId"]);
});

test("normalizaciones equivalentes no crean un user alternativo", () => {
  const variants = ["TEST@example.invalid", " test@example.invalid ", "test@EXAMPLE.invalid"];
  assert.deepStrictEqual([...new Set(variants.map(userDocId))], ["test@example.invalid"]);
});

test("repairUsers exige evidencia explícita y timestamp válido", () => {
  expectCode(() => validateBackfillRequestBody(request({ operation: "repairUsers" })), "USER_REPAIRS_REQUIRED");
  expectCode(() => validateBackfillRequestBody(request({
    operation: "repairUsers",
    repairs: [{ studentId: "student-1", users: [{ emailIndex: 0, restoreUpdatedAt: "not-a-time" }] }],
  })), "INVALID_USER_REPAIR_TIMESTAMP");
  const validated = validateBackfillRequestBody(request({
    operation: "repairUsers",
    repairs: [{
      studentId: "student-1",
      users: [{ emailIndex: 0, restoreUpdatedAt: "2026-07-11T16:20:23.730Z" }],
    }],
  }));
  assert.strictEqual(validated.operation, "repairUsers");
});

test("parche Bitácoras conserva estado y datos académicos", () => {
  const existing = { estado: "activo", status: "ok", active: true, statusSource: "rip", programa: "X", historial: [1] };
  const patch = minimalBitacorasIdentityPatch(normalizedFixture(), existing);
  for (const field of ["estado", "status", "active", "statusSource", "programa", "historial", "updatedAt"]) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(patch, field), false);
  }
});

test("parche RIP conserva pagos, programación, estado y timestamps propios", () => {
  const existing = { pagos: [1], programacion: { day: 1 }, estado: "activo", status: "ok", active: true, updatedAt: "rip-time" };
  const patch = minimalRipIdentityPatch(normalizedFixture(), existing);
  for (const field of ["pagos", "programacion", "estado", "status", "active", "updatedAt", "createdAt"]) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(patch, field), false);
  }
});

test("segunda ejecución materialmente equivalente produce no_op", () => {
  const patch = { studentId: "student-1", studentIds: ["student-1"], identity: { source: "source", name: "Test" } };
  const first = backfillPatchDiff({}, patch);
  const second = backfillPatchDiff({ ...patch, identity: { ...patch.identity, preservedExtra: true } }, patch);
  assert.strictEqual(first.material, true);
  assert.strictEqual(second.material, false);
});

test("hash del plan es estable y cambia con una versión concurrente", () => {
  const plan = emptyPlan();
  const first = buildBackfillPlanHash(plan);
  const second = buildBackfillPlanHash(plan);
  assert.strictEqual(first, second);
  plan.students[0].sourceVersion = "v2";
  assert.notStrictEqual(buildBackfillPlanHash(plan), first);
});

test("respuesta pública no incluye IDs, paths, patches ni valores personales", () => {
  const plan = emptyPlan();
  plan.planHash = buildBackfillPlanHash(plan);
  const response = publicBackfillPlan(plan);
  const serialized = JSON.stringify(response);
  assert.ok(!serialized.includes("test@example.invalid"));
  assert.ok(!serialized.includes('"patch"'));
  assert.ok(!serialized.includes('"docId"'));
});

test("IDs con forma de correo usan fingerprint no reversible", () => {
  const masked = maskTechnicalId("historical.user@example.invalid");
  assert.match(masked, /^sid#[a-f0-9]{8}$/);
  assert.ok(!masked.includes("historical"));
  assert.ok(!masked.includes("invalid"));
});

test("errores se convierten a códigos técnicos", () => {
  assert.strictEqual(safeBackfillErrorCode(new Error("correo test@example.invalid")), "BACKFILL_INTERNAL_ERROR");
  assert.strictEqual(safeBackfillErrorCode(new BackfillRequestError("PLAN_STALE", 409)), "PLAN_STALE");
});

test("piloto está excluido y no hay selección global ni side effects", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const safeSection = source.slice(source.indexOf("const BACKFILL_MAX_STUDENTS"), source.indexOf("const DOCUMENT_TYPES"));
  const endpoint = source.slice(source.indexOf("exports.backfillStudentIdentity"), source.indexOf("exports.diagnoseStudentAccess"));
  assert.ok(safeSection.includes('BACKFILL_PILOT_ID = "msQWTSLw0PZwR6JtZOBz"'));
  assert.ok(safeSection.includes('student.codes.push("PILOT_EXCLUDED")'));
  assert.ok(!endpoint.includes("req.query.limit"));
  assert.ok(!endpoint.includes("pageSize"));
  assert.ok(!endpoint.includes("orderBy("));
  for (const forbidden of ["processStudentRegistrationSideEffects", "integration_jobs", "registration_events", "sendEmail", "LEGACY_APPS_SCRIPT_URL", "writeSyncStatus", "logSyncError", ".delete("]) {
    assert.ok(!endpoint.includes(forbidden), `endpoint contiene ${forbidden}`);
  }
});

test("logging del endpoint no serializa Error, message ni payload", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const endpoint = source.slice(source.indexOf("exports.backfillStudentIdentity"), source.indexOf("exports.diagnoseStudentAccess"));
  assert.ok(!/logger\.(?:info|warn|error)\([^;]*,\s*error\s*\)/s.test(endpoint));
  assert.ok(!/error\.(?:message|stack)/.test(endpoint));
  assert.ok(!/JSON\.stringify\(error/.test(endpoint));
  assert.ok(endpoint.includes("safeBackfillErrorCode(error)"));
});

test("snapshot cifra con DPAPI y verifica descifrado", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicala-backfill-test-"));
  const fixture = path.join(dir, "fixture.json");
  const encrypted = path.join(dir, "snapshot.backfill-snapshot.dpapi");
  const tools = path.join(__dirname, "..", "..", "tools");
  const payload = validSnapshotPayload();
  payload.documents[0].content.fields.value.stringValue = "before-secret";
  payload.documents[0].path = "students/student-1";
  payload.documents[0].content.name = "projects/test-project/databases/(default)/documents/students/student-1";
  payload.documents[1].path = "students/student-created";
  fs.writeFileSync(fixture, JSON.stringify(payload), "utf8");
  const result = runPowerShell(path.join(tools, "prepare-backfill-snapshot.ps1"), [
    "-OutputPath", encrypted, "-FixtureInputPath", fixture,
  ]);
  assert.strictEqual(result.encrypted, true);
  assert.strictEqual(result.verified, true);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.ok(!fs.readFileSync(encrypted).includes(Buffer.from("before-secret")));
  snapshotTest.dir = dir;
  snapshotTest.encrypted = encrypted;
  snapshotTest.hash = result.sha256;
  snapshotTest.tools = tools;
});

test("snapshot rechaza contenedor técnico sin preimágenes", () => {
  const fixture = path.join(snapshotTest.dir, "technical-container.json");
  fs.writeFileSync(fixture, JSON.stringify({
    schemaVersion: 2, runId: "fixture-run", createdAt: "2026-07-12T00:00:00.000Z",
    documents: [{ value: validSnapshotPayload(1).documents, Count: 1 }],
  }), "utf8");
  runPowerShellFailure(path.join(snapshotTest.tools, "prepare-backfill-snapshot.ps1"), [
    "-OutputPath", path.join(snapshotTest.dir, "technical.dpapi"), "-FixtureInputPath", fixture,
  ], "SNAPSHOT_CONTENT_INVALID");
});

test("snapshot rechaza documents vacío", () => {
  const fixture = path.join(snapshotTest.dir, "empty.json");
  fs.writeFileSync(fixture, JSON.stringify({
    schemaVersion: 2, runId: "fixture-run", createdAt: "2026-07-12T00:00:00.000Z", documents: [],
  }), "utf8");
  runPowerShellFailure(path.join(snapshotTest.tools, "prepare-backfill-snapshot.ps1"), [
    "-OutputPath", path.join(snapshotTest.dir, "empty.dpapi"), "-FixtureInputPath", fixture,
  ], "SNAPSHOT_CONTENT_INVALID");
});

test("snapshot rechaza content ausente en documento preexistente", () => {
  const fixture = path.join(snapshotTest.dir, "missing-content.json");
  const payload = validSnapshotPayload(1);
  delete payload.documents[0].content;
  fs.writeFileSync(fixture, JSON.stringify(payload), "utf8");
  runPowerShellFailure(path.join(snapshotTest.tools, "prepare-backfill-snapshot.ps1"), [
    "-OutputPath", path.join(snapshotTest.dir, "missing-content.dpapi"), "-FixtureInputPath", fixture,
  ], "SNAPSHOT_CONTENT_INVALID");
});

test("snapshot acepta 50 preimágenes válidas", () => {
  const fixture = path.join(snapshotTest.dir, "fifty.json");
  const encrypted = path.join(snapshotTest.dir, "fifty.dpapi");
  fs.writeFileSync(fixture, JSON.stringify(validSnapshotPayload(50)), "utf8");
  const result = runPowerShell(path.join(snapshotTest.tools, "prepare-backfill-snapshot.ps1"), [
    "-OutputPath", encrypted, "-FixtureInputPath", fixture,
  ]);
  assert.strictEqual(result.documents, 50);
  assert.strictEqual(result.verified, true);
});

test("rollback restaura preimágenes exactas", () => {
  const current = path.join(snapshotTest.dir, "current.json");
  const restored = path.join(snapshotTest.dir, "restored.json");
  fs.writeFileSync(current, JSON.stringify({ documents: [
    { project: "test-project", path: "students/student-1", content: { fields: { value: { stringValue: "after" } } } },
    { project: "test-project", path: "students/student-created", content: { fields: { value: { stringValue: "created" } } } },
    { project: "test-project", path: "students/unrelated", content: { fields: { value: { stringValue: "untouched" } } } },
  ] }), "utf8");
  const result = runPowerShell(path.join(snapshotTest.tools, "rollback-backfill-snapshot.ps1"), [
    "-SnapshotPath", snapshotTest.encrypted,
    "-ExpectedSha256", snapshotTest.hash,
    "-FixtureStatePath", current,
    "-FixtureResultPath", restored,
  ]);
  assert.strictEqual(result.restored, 1);
  snapshotTest.restored = JSON.parse(fs.readFileSync(restored, "utf8"));
  const original = snapshotTest.restored.documents.find((item) => item.path === "students/student-1");
  assert.strictEqual(original.content.fields.value.stringValue, "before-secret");
});

test("rollback elimina únicamente documentos creados por el lote", () => {
  assert.ok(!snapshotTest.restored.documents.some((item) => item.path === "students/student-created"));
  const unrelated = snapshotTest.restored.documents.find((item) => item.path === "students/unrelated");
  assert.strictEqual(unrelated.content.fields.value.stringValue, "untouched");
  const prepareSource = fs.readFileSync(path.join(snapshotTest.tools, "prepare-backfill-snapshot.ps1"), "utf8");
  const commonSource = fs.readFileSync(path.join(snapshotTest.tools, "snapshot-common.ps1"), "utf8");
  assert.ok(commonSource.includes("DataProtectionScope]::CurrentUser"));
  assert.ok(!/clipboard|Set-Clipboard|Get-Clipboard/i.test(prepareSource));
});

test("snapshot inválido bloquea apply antes de una solicitud HTTP", () => {
  const invalid = path.join(snapshotTest.dir, "invalid-before-apply.dpapi");
  const bytes = Buffer.from(fs.readFileSync(snapshotTest.encrypted));
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  fs.writeFileSync(invalid, bytes);
  runPowerShellFailure(path.join(snapshotTest.tools, "rollback-backfill-snapshot.ps1"), [
    "-SnapshotPath", invalid, "-Apply",
  ], "SNAPSHOT_CONTENT_INVALID");
  fs.rmSync(snapshotTest.dir, { recursive: true, force: true });
});

(async () => {
  let passed = 0;
  for (const current of tests) {
    try {
      await current.fn();
      passed += 1;
      console.log(`ok ${passed} - ${current.name}`);
    } catch (error) {
      console.error(`not ok ${passed + 1} - ${current.name}`);
      throw error;
    }
  }
  console.log(`# ${passed}/${tests.length} backfill tests passed`);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : "BACKFILL_TEST_FAILED");
  process.exitCode = 1;
});

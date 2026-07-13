"use strict";

/*
  Pruebas unitarias de syncStudentIdentity (sin red, sin credenciales).
  Ejecutar: node test/identity.test.js  (desde firebase-sync/functions)
*/

const assert = require("node:assert");
const { _internals } = require("../index.js");

const {
  normalizeStudent,
  mergeProcesses,
  isAllowedStudentStatus,
  ripOwnsStatus,
  extractEmails,
  collectDocumentValues,
  looksLikeDocumentNumber,
  filterSensitiveAliases,
  normalizeDocumentForFingerprint,
  buildDocumentFingerprint,
  fingerprintDecision,
  identityRelevantFingerprint,
  identityChangeDecision,
  maskTechnicalId,
  safeTechnicalCode,
  buildTechnicalLog,
} = _internals;

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

test("el studentId canónico es el ID del documento (sourceDocId)", () => {
  const normalized = normalizeStudent(
    { studentName: "Ana Pérez", studentEmail: "ana@test.com" },
    "aB3xK9mP2vR7sT4wX8Zz"
  );
  assert.strictEqual(normalized.studentId, "aB3xK9mP2vR7sT4wX8Zz");
  assert.strictEqual(normalized.idConflict, false);
});

test("conflicto: studentId declarado distinto → manda el ID de la ruta y queda marcado", () => {
  const normalized = normalizeStudent(
    { studentName: "Ana Pérez", studentId: "OTRO_ID_DIFERENTE_123" },
    "aB3xK9mP2vR7sT4wX8Zz"
  );
  assert.strictEqual(normalized.studentId, "aB3xK9mP2vR7sT4wX8Zz");
  assert.strictEqual(normalized.idConflict, true);
  assert.strictEqual(normalized.declaredStudentId, "OTRO_ID_DIFERENTE_123");
});

test("contactId es alias; el documento real NUNCA aparece en aliases", () => {
  const normalized = normalizeStudent(
    {
      studentName: "Ana Pérez",
      contactId: "uuid-legado-1234",
      studentDocument: "CC1030599272",
      // Aunque un sync antiguo lo haya metido en studentIds, se filtra:
      studentIds: ["CC1030599272", "1030599272", "viejo-id-firestore"],
    },
    "aB3xK9mP2vR7sT4wX8Zz"
  );
  assert.strictEqual(normalized.studentId, "aB3xK9mP2vR7sT4wX8Zz");
  assert.ok(normalized.studentIds.includes("uuid-legado-1234"));
  assert.ok(normalized.studentIds.includes("viejo-id-firestore"));
  assert.ok(!normalized.studentIds.includes("CC1030599272"), "documento con tipo filtrado");
  assert.ok(!normalized.studentIds.includes("1030599272"), "documento sin tipo filtrado");
  assert.strictEqual(normalized.contactId, "uuid-legado-1234");
});

test("filterSensitiveAliases: detección por valor exacto y por patrón", () => {
  const docs = collectDocumentValues({ studentDocument: "CC 1030599272" });
  const clean = filterSensitiveAliases(
    ["aB3xK9mP2vR7sT4wX8Zz", "cc1030599272", "TI98765432", "stu_ana_45", "45", "uuid-1"],
    docs
  );
  assert.deepStrictEqual(clean, ["aB3xK9mP2vR7sT4wX8Zz", "stu_ana_45", "45", "uuid-1"]);
  assert.strictEqual(looksLikeDocumentNumber("PAS-AB12345"), true);
  assert.strictEqual(looksLikeDocumentNumber("stu_juan_perez_12"), false);
  assert.strictEqual(looksLikeDocumentNumber("45"), false, "sourceRow corto no es documento");
});

test("huella HMAC: determinista, sin exponer el documento, cambia con el secreto", () => {
  const normalizedDoc = normalizeDocumentForFingerprint({ studentDocument: "cc 1.030.599-272" });
  assert.strictEqual(normalizedDoc, "CC1030599272");
  const a = buildDocumentFingerprint(normalizedDoc, "secreto-1");
  const b = buildDocumentFingerprint(normalizedDoc, "secreto-1");
  const c = buildDocumentFingerprint(normalizedDoc, "secreto-2");
  assert.strictEqual(a, b, "idempotente con el mismo secreto");
  assert.notStrictEqual(a, c, "otro secreto → otra huella");
  assert.ok(!a.includes("1030599272"), "la huella no contiene el número");
  assert.strictEqual(buildDocumentFingerprint("", "secreto"), "", "sin documento no hay huella");
  assert.strictEqual(buildDocumentFingerprint("CC123456", ""), "", "sin secreto no hay huella");
});

test("huella caso 1: estudiante nuevo sin huella → se calcula", () => {
  assert.strictEqual(
    fingerprintDecision({ studentDocument: "CC1030599272" }),
    "compute"
  );
  assert.strictEqual(fingerprintDecision({}), "no_document", "sin documento no hay nada que calcular");
});

test("huella caso 2: histórico con SHA antiguo (sin fingerprintVersion 2) → se RECALCULA y reemplaza", () => {
  // SHA viejo guardado como documentFingerprint por una versión previa.
  assert.strictEqual(
    fingerprintDecision({ studentDocument: "CC1030599272", documentFingerprint: "sha-viejo-abc" }),
    "compute"
  );
  // documentShaLegacy nunca cuenta como huella definitiva.
  assert.strictEqual(
    fingerprintDecision({ studentDocument: "CC1030599272", documentShaLegacy: "sha-legado" }),
    "compute"
  );
  // Ni siquiera con una versión distinta de 2.
  assert.strictEqual(
    fingerprintDecision({ studentDocument: "CC1030599272", documentFingerprint: "x", fingerprintVersion: 1 }),
    "compute"
  );
});

test("huella caso 3: HMAC v2 ya presente → definitiva, no se recalcula", () => {
  assert.strictEqual(
    fingerprintDecision({ studentDocument: "CC1030599272", documentFingerprint: "hmac-v2", fingerprintVersion: 2 }),
    "skip_definitive"
  );
});

test("huella caso 4: duplicado detectable por HMAC (mismo documento → misma huella)", () => {
  const a = buildDocumentFingerprint(normalizeDocumentForFingerprint({ studentDocument: "CC 1.030.599-272" }), "secreto");
  const b = buildDocumentFingerprint(normalizeDocumentForFingerprint({ documento: "cc1030599272" }), "secreto");
  const c = buildDocumentFingerprint(normalizeDocumentForFingerprint({ studentDocument: "CC99999999" }), "secreto");
  assert.strictEqual(a, b, "mismo documento con formatos distintos → misma huella → colisión en el índice → hold");
  assert.notStrictEqual(a, c, "documentos distintos jamás colisionan");
});

test("huella caso 5: reejecución idempotente (tras calcular, la decisión es skip)", () => {
  const raw = { studentDocument: "CC1030599272" };
  assert.strictEqual(fingerprintDecision(raw), "compute");
  // Lo que el backend escribe en la transacción:
  const after = { ...raw, documentFingerprint: buildDocumentFingerprint("CC1030599272", "secreto"), fingerprintVersion: 2 };
  assert.strictEqual(fingerprintDecision(after), "skip_definitive");
  assert.strictEqual(fingerprintDecision(after), fingerprintDecision(after), "determinista");
});

test("identityHold en el origen impide la sincronización (flag visible)", () => {
  const normalized = normalizeStudent(
    { studentName: "Ana Pérez", identityHold: true },
    "aB3xK9mP2vR7sT4wX8Zz"
  );
  assert.strictEqual(normalized.identityHold, true);
});

test("sin nombre no se sincroniza", () => {
  assert.strictEqual(normalizeStudent({ email: "x@y.com" }, "abc123"), null);
});

test("extractEmails encuentra correos de estudiante y acudiente", () => {
  const emails = extractEmails("Ana <ANA@Test.com>", ["acudiente@test.com"]);
  assert.deepStrictEqual(emails, ["acudiente@test.com", "ana@test.com"]);
});

test("mergeProcesses conserva áreas agregadas a mano en Bitácoras", () => {
  const existing = [
    { arte: "Música", detalle: "Guitarra" },
    { arte: "Teatro", detalle: "Improvisación" },
  ];
  const synced = [{ arte: "Música", detalle: "Guitarra", label: "Música - Guitarra" }];
  const merged = mergeProcesses(existing, synced);
  assert.strictEqual(merged.length, 2);
  assert.ok(merged.some((p) => p.arte === "Teatro"));
});

test("política transicional de estados de Lista", () => {
  assert.strictEqual(isAllowedStudentStatus("Activo"), true);
  assert.strictEqual(isAllowedStudentStatus("Activo no registro (8-15 dias)"), true);
  assert.strictEqual(isAllowedStudentStatus("Inactivo en pausa (1-3 meses)"), true);
  assert.strictEqual(isAllowedStudentStatus("Inactivo en pausa (3–6 meses)"), false);
  assert.strictEqual(isAllowedStudentStatus("Exestudiante (+24 meses)"), false);
});

test("ripOwnsStatus detecta cuándo el estado ya es de RIP", () => {
  assert.strictEqual(ripOwnsStatus({}), false);
  assert.strictEqual(ripOwnsStatus({ rip: {} }), false);
  assert.strictEqual(ripOwnsStatus({ rip: { statusVersion: 123 } }), true);
  assert.strictEqual(ripOwnsStatus({ rip: { statusLabel: "Activo" } }), true);
});

test("reejecución: normalizeStudent es determinista (idempotencia)", () => {
  const raw = { studentName: "Ana Pérez", studentEmail: "ana@test.com", contactId: "uuid-1" };
  const a = normalizeStudent(raw, "aB3xK9mP2vR7sT4wX8Zz");
  const b = normalizeStudent(raw, "aB3xK9mP2vR7sT4wX8Zz");
  assert.deepStrictEqual(a, b);
});

const pilotSourceId = "msQWTSLw0PZwR6JtZOBz";
const pilotIdentity = {
  studentName: "PRUEBA PILOTO QA",
  studentEmail: "merakiplusmusic@gmail.com",
  studentDocument: "CC11111111",
  course: "Música",
  contactId: "contact-pilot-1",
  updatedAt: "2026-07-12T16:49:10Z",
};

test("guard 1: la creación inicial sincroniza", () => {
  assert.deepStrictEqual(identityChangeDecision({
    beforeExists: false,
    afterExists: true,
    before: {},
    after: pilotIdentity,
    sourceDocId: pilotSourceId,
  }), { shouldSync: true, reason: "created" });
});

test("guard 2: guardar documentFingerprint no vuelve a sincronizar", () => {
  const after = {
    ...pilotIdentity,
    documentFingerprint: "a".repeat(64),
    fingerprintVersion: 2,
    updatedAt: "2026-07-12T16:49:13Z",
  };
  assert.deepStrictEqual(identityChangeDecision({
    beforeExists: true,
    afterExists: true,
    before: pilotIdentity,
    after,
    sourceDocId: pilotSourceId,
  }), { shouldSync: false, reason: "internal_metadata_only" });
});

test("guard 3: cambiar solo updatedAt retorna no-op", () => {
  const after = { ...pilotIdentity, updatedAt: "2026-07-12T18:00:00Z" };
  assert.strictEqual(identityChangeDecision({
    beforeExists: true,
    afterExists: true,
    before: pilotIdentity,
    after,
    sourceDocId: pilotSourceId,
  }).shouldSync, false);
});

test("guard 4: un cambio real de identidad sí sincroniza", () => {
  for (const after of [
    { ...pilotIdentity, studentName: "Nombre corregido" },
    { ...pilotIdentity, studentEmail: "nuevo@example.com" },
    { ...pilotIdentity, course: "Teatro" },
    { ...pilotIdentity, studentDocument: "CC22222222" },
  ]) {
    assert.deepStrictEqual(identityChangeDecision({
      beforeExists: true,
      afterExists: true,
      before: pilotIdentity,
      after,
      sourceDocId: pilotSourceId,
    }), { shouldSync: true, reason: "identity_changed" });
  }
});

test("guard 5: retries conservan una decisión determinista e idempotente", () => {
  const changed = { ...pilotIdentity, course: "Teatro" };
  const a = identityRelevantFingerprint(changed, pilotSourceId);
  const b = identityRelevantFingerprint(changed, pilotSourceId);
  assert.strictEqual(a, b);
  assert.deepStrictEqual(
    identityChangeDecision({
      beforeExists: true, afterExists: true,
      before: pilotIdentity, after: changed, sourceDocId: pilotSourceId,
    }),
    identityChangeDecision({
      beforeExists: true, afterExists: true,
      before: pilotIdentity, after: changed, sourceDocId: pilotSourceId,
    })
  );
});

test("logs 6: metadatos técnicos no contienen PII ni IDs completos", () => {
  const entry = buildTechnicalLog({
    eventId: "event-123",
    studentId: pilotSourceId,
    status: "completed",
    durationMs: 25,
    operations: ["document_index", "bitacoras_student", "merakiplusmusic@gmail.com"],
    code: "OK",
    counts: {
      writes: 3,
      recipients: 1,
      email: 1,
      studentDocument: 1,
      name: 1,
      phone: 1,
      address: 1,
      health: 1,
    },
  });
  const serialized = JSON.stringify(entry);
  for (const forbidden of [
    "merakiplusmusic@gmail.com",
    "PRUEBA PILOTO QA",
    "CC11111111",
    "studentDocument",
    "phone",
    "address",
    "health",
    pilotSourceId,
  ]) {
    assert.ok(!serialized.includes(forbidden), `log sin ${forbidden}`);
  }
  assert.strictEqual(entry.studentId, "msQW...ZOBz");
  assert.deepStrictEqual(entry.operations, ["bitacoras_student", "document_index"]);
  assert.deepStrictEqual(entry.counts, { writes: 3, recipients: 1 });
  assert.strictEqual(maskTechnicalId(pilotSourceId), "msQW...ZOBz");
  assert.strictEqual(safeTechnicalCode(new Error("correo privado@example.com")), "Error");
});

test("auditoría estática: el trigger no registra resultados ni errores completos", () => {
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const triggerBlock = source.slice(
    source.indexOf("exports.syncStudentIdentity = onDocumentWritten"),
    source.indexOf("exports.backfillStudentIdentity = onRequest")
  );
  assert.ok(!/logger\.(?:info|warn|error)\([^;]*,\s*result\s*\)/s.test(triggerBlock));
  assert.ok(!/logger\.(?:info|warn|error)\([^;]*,\s*error\s*\)/s.test(triggerBlock));
  assert.match(triggerBlock, /identityChangeDecision/);
  assert.match(triggerBlock, /status:\s*"no_op"/);
});

console.log(`\n${passed} pruebas OK (identity)`);

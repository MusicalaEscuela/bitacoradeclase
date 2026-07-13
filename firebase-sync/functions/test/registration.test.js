"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  _internals: {
    normalizeRegistrationEmail,
    normalizeRegistrationDocument,
    duplicateResponse,
    buildDocumentFingerprint,
    buildLegacyRegistrationPayload,
    missingSideEffectActions,
    mergeSideEffectResult,
    sideEffectStatus,
    safeLegacyErrorCode,
    parseLegacyResponse,
    assertLegacyExecUrl,
  },
} = require("../index.js");

function expectThrows(fn, expectedCode) {
  try {
    fn();
  } catch (error) {
    if (expectedCode) assert.strictEqual(error.code, expectedCode);
    return error;
  }
  throw new assert.AssertionError({ message: `Se esperaba una excepción (${expectedCode || "cualquiera"})` });
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

test("normaliza correo y documento antes de consultar Firebase", () => {
  assert.strictEqual(normalizeRegistrationEmail(" ANA@Example.COM "), "ana@example.com");
  assert.strictEqual(normalizeRegistrationDocument("cc", "1.030.599-272"), "CC1030599272");
  assert.strictEqual(normalizeRegistrationDocument("XX", "123456"), "");
});

test("duplicado por correo devuelve solo banderas y mensaje genérico", () => {
  const result = duplicateResponse(true, false);
  assert.deepStrictEqual(Object.keys(result).sort(), [
    "canContinue", "duplicate", "duplicateByDocument", "duplicateByEmail", "message",
  ].sort());
  assert.strictEqual(result.duplicate, true);
  assert.strictEqual(result.canContinue, false);
  assert.ok(!JSON.stringify(result).includes("studentId"));
});

test("duplicado por documento usa una huella HMAC determinista", () => {
  const a = buildDocumentFingerprint("CC1030599272", "secret");
  const b = buildDocumentFingerprint("CC1030599272", "secret");
  assert.strictEqual(a, b);
  assert.strictEqual(duplicateResponse(false, true).duplicateByDocument, true);
});

test("payload legado usa studentId y excluye huellas, tokens y payload técnico", () => {
  const payload = buildLegacyRegistrationPayload({
    studentName: "Ana",
    studentEmail: "ana@example.com",
    documentFingerprint: "private-hmac",
    documentShaLegacy: "legacy",
    photoUrl: "private-photo",
    token: "secret",
  }, "student-1");
  assert.strictEqual(payload.studentId, "student-1");
  assert.strictEqual(payload.firebaseDocumentId, "student-1");
  assert.strictEqual(payload.studentName, "Ana");
  assert.strictEqual(payload.documentFingerprint, undefined);
  assert.strictEqual(payload.documentShaLegacy, undefined);
  assert.strictEqual(payload.token, undefined);
  assert.strictEqual(payload.photoUrl, undefined);
});

test("primer intento solicita las tres tareas", () => {
  assert.deepStrictEqual(missingSideEffectActions({}), {
    syncSheet: true,
    sendWelcomeEmail: true,
    sendInternalNotification: true,
  });
});

test("retry solicita únicamente tareas faltantes", () => {
  assert.deepStrictEqual(missingSideEffectActions({
    sheetSynced: true,
    welcomeEmailSent: false,
    internalNotificationSent: true,
  }), {
    syncSheet: false,
    sendWelcomeEmail: true,
    sendInternalNotification: false,
  });
});

test("resultado parcial conserva tareas ya completadas", () => {
  const merged = mergeSideEffectResult(
    { sheetSynced: true, welcomeEmailSent: false, internalNotificationSent: false },
    { sheetSynced: false, welcomeEmailSent: true, internalNotificationSent: false }
  );
  assert.deepStrictEqual(merged, {
    sheetSynced: true,
    welcomeEmailSent: true,
    internalNotificationSent: false,
  });
  assert.strictEqual(sideEffectStatus(merged), "partial");
});

test("estado completed exige hoja y ambos correos", () => {
  assert.strictEqual(sideEffectStatus({
    sheetSynced: true,
    welcomeEmailSent: true,
    internalNotificationSent: true,
  }), "completed");
  assert.strictEqual(sideEffectStatus({}), "failed");
});

test("errores persistidos son códigos acotados, no payloads", () => {
  assert.strictEqual(safeLegacyErrorCode(new Error("falló: correo privado@example.com")), "Error");
});

test("respuesta HTTP 200 + {ok:false} se considera FALLO", () => {
  const err = expectThrows(
    () => parseLegacyResponse({ okHttp: true, status: 200, bodyText: JSON.stringify({ ok: false, errorCode: "UNSUPPORTED_EVENT_TYPE" }) }),
    "UNSUPPORTED_EVENT_TYPE"
  );
  // Solo conserva banderas booleanas, nunca el payload completo.
  assert.deepStrictEqual(Object.keys(err.legacyResult).sort(), [
    "errorCode", "internalNotificationSent", "sheetSynced", "welcomeEmailSent",
  ]);
});

test("HTTP 200 sin errorCode explícito → LEGACY_REJECTED (no éxito por HTTP ok)", () => {
  expectThrows(() => parseLegacyResponse({ okHttp: true, status: 200, bodyText: JSON.stringify({ ok: false }) }), "LEGACY_REJECTED");
  // Falta total de la bandera ok tampoco es éxito.
  expectThrows(() => parseLegacyResponse({ okHttp: true, status: 200, bodyText: JSON.stringify({ sheetSynced: true }) }), "LEGACY_REJECTED");
});

test("respuesta HTTP 200 + JSON inválido se considera FALLO", () => {
  expectThrows(() => parseLegacyResponse({ okHttp: true, status: 200, bodyText: "<html>Drive: no disponible</html>" }), "LEGACY_NON_JSON");
  expectThrows(() => parseLegacyResponse({ okHttp: true, status: 200, bodyText: "" }), "LEGACY_NON_JSON");
});

test("respuesta HTTP 500 se considera FALLO (no llega a parsear el cuerpo)", () => {
  expectThrows(() => parseLegacyResponse({ okHttp: false, status: 500, bodyText: JSON.stringify({ ok: true }) }), "LEGACY_HTTP_500");
});

test("respuesta {ok:true} se considera ÉXITO y expone banderas normalizadas", () => {
  const result = parseLegacyResponse({
    okHttp: true, status: 200,
    bodyText: JSON.stringify({ ok: true, sheetSynced: true, welcomeEmailSent: true, internalNotificationSent: false }),
  });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(
    { s: result.sheetSynced, w: result.welcomeEmailSent, i: result.internalNotificationSent },
    { s: true, w: true, i: false }
  );
});

test("fallo parcial: el merge conserva lo confirmado y no repite esas tareas", () => {
  // Intento 1 confirma la hoja, falla el correo interno → parcial.
  const job1 = { sheetSynced: false, welcomeEmailSent: false, internalNotificationSent: false };
  const partial = parseLegacyResponse({
    okHttp: true, status: 200,
    bodyText: JSON.stringify({ ok: true, sheetSynced: true, welcomeEmailSent: true, internalNotificationSent: false }),
  });
  const merged1 = mergeSideEffectResult(job1, partial);
  assert.strictEqual(sideEffectStatus(merged1), "partial");
  // El retry solo pide lo que falta (la notificación interna).
  assert.deepStrictEqual(missingSideEffectActions(merged1), {
    syncSheet: false, sendWelcomeEmail: false, sendInternalNotification: true,
  });
  // Intento 2 confirma lo que faltaba → completed, sin rehacer lo anterior.
  const merged2 = mergeSideEffectResult(merged1, { internalNotificationSent: true });
  assert.strictEqual(sideEffectStatus(merged2), "completed");
});

test("timeout / error de red se traducen a código de fallo acotado", () => {
  // safeLegacyErrorCode nunca filtra el mensaje con datos privados.
  assert.strictEqual(safeLegacyErrorCode({ code: "LEGACY_TIMEOUT" }), "LEGACY_TIMEOUT");
  assert.strictEqual(safeLegacyErrorCode({ code: "LEGACY_NETWORK_ERROR" }), "LEGACY_NETWORK_ERROR");
});

test("assertLegacyExecUrl exige /exec y rechaza /dev o vacío", () => {
  assert.strictEqual(
    assertLegacyExecUrl("https://script.google.com/macros/s/ABC/exec"),
    "https://script.google.com/macros/s/ABC/exec"
  );
  expectThrows(() => assertLegacyExecUrl("https://script.google.com/macros/s/ABC/dev"), "LEGACY_URL_NOT_EXEC");
  expectThrows(() => assertLegacyExecUrl("https://script.google.com/macros/s/ABC/"), "LEGACY_URL_NOT_EXEC");
  expectThrows(() => assertLegacyExecUrl(""), "LEGACY_CONFIGURATION_MISSING");
});

test("syncStudentIdentity conserva su trigger independiente", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(source, /exports\.syncStudentIdentity\s*=\s*onDocumentWritten/);
  assert.match(source, /exports\.processStudentRegistrationSideEffects\s*=\s*onDocumentCreated/);
});

console.log(`\n${passed} pruebas OK (registration backend)`);

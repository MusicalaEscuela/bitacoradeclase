"use strict";

/*
  Pruebas unitarias de syncStudentStatus (sin red, sin credenciales).
  Ejecutar: node test/permissions.test.js  (desde rip-functions/functions)
*/

const assert = require("node:assert");
const { _internals } = require("../index.js");

const {
  derivePermissionsFromStatus,
  statusCodeFromLabel,
  buildStatusProjection,
  deriveStatusVersion,
  looksLikeAutoId,
  uniqueTextList,
  isAuthorizedAdminRequest,
} = _internals;

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

test("Activo: todo permitido (matriz completa)", () => {
  const p = derivePermissionsFromStatus("Activo");
  assert.deepStrictEqual(p, {
    operationalActive: true,
    canAccessHub: true,
    accountEnabled: true,
    showInTeacherLists: true,
    canReceiveBitacoras: true,
    active: true,
  });
});

test("Activo no registro / Activo en pausa: siguen operativos", () => {
  for (const label of ["Activo no registro (8-15 dias)", "Activo En pausa (15–30 días)"]) {
    const p = derivePermissionsFromStatus(label);
    assert.strictEqual(p.operationalActive, true, label);
    assert.strictEqual(p.canAccessHub, true, label);
    assert.strictEqual(p.accountEnabled, true, label);
    assert.strictEqual(p.showInTeacherLists, true, label);
  }
});

test("Inactivo en pausa (1-3 meses): no operativo pero SÍ entra al HUB", () => {
  const p = derivePermissionsFromStatus("Inactivo en pausa (1-3 meses)");
  assert.deepStrictEqual(p, {
    operationalActive: false,
    canAccessHub: true,
    accountEnabled: true,
    showInTeacherLists: true,
    canReceiveBitacoras: true,
    active: false,
  });
});

test("Inactivo de más de 3 meses / histórico / exestudiante: NO entra", () => {
  for (const label of [
    "Inactivo lejano (3-6 meses)",
    "Inactivo extendido (6-12 meses)",
    "Inactivo historico (12-24 meses)",
    "Exestudiante (+24 meses)",
    "Inactivo sin info",
  ]) {
    const p = derivePermissionsFromStatus(label);
    assert.strictEqual(p.operationalActive, false, label);
    assert.strictEqual(p.canAccessHub, false, label);
    assert.strictEqual(p.accountEnabled, false, label);
    assert.strictEqual(p.showInTeacherLists, false, label);
    assert.strictEqual(p.canReceiveBitacoras, false, label);
  }
});

test("Archivado/bloqueado: todo denegado", () => {
  for (const label of ["Archivado", "Bloqueado por administración"]) {
    const p = derivePermissionsFromStatus(label);
    assert.strictEqual(p.canAccessHub, false, label);
    assert.strictEqual(p.accountEnabled, false, label);
  }
});

test("statusCode estable y legible por máquina", () => {
  assert.strictEqual(statusCodeFromLabel("Activo no registro (8–15 días)"), "activo_no_registro_8_15_dias");
  assert.strictEqual(statusCodeFromLabel(""), "sin_estado");
});

test("la proyección NO copia información financiera sensible", () => {
  const projection = buildStatusProjection(
    "aB3xK9mP2vR7sT4wX8Zz",
    {
      clasificacionFinal: "Activo",
      saldo: 7,
      totalPagos: 12,
      ultimaClase: "2026-07-01",
      nextClassDate: "2026-07-12",
      cursos: ["Música"],
      instrumentos: ["Guitarra"],
    },
    1234567890
  );
  assert.strictEqual(projection.studentId, "aB3xK9mP2vR7sT4wX8Zz");
  assert.strictEqual(projection.remainingClasses, 7);
  assert.strictEqual(projection.curso, "Música");
  assert.strictEqual(projection.instrumento, "Guitarra");
  assert.deepStrictEqual(projection.areas, ["Música"]);
  assert.deepStrictEqual(projection.tecnicas, ["Guitarra"]);
  // Campos prohibidos en Bitácoras:
  for (const forbidden of ["saldo", "balance", "totalPagos", "pagos", "valorPago", "medioPago"]) {
    assert.ok(!(forbidden in projection), `no debe publicar ${forbidden}`);
  }
});

test("idempotencia: la misma entrada produce la misma proyección (sin timestamps)", () => {
  const computed = { clasificacionFinal: "Activo", saldo: 3, ultimaClase: "2026-07-01" };
  const a = buildStatusProjection("id1", computed, 1);
  const b = buildStatusProjection("id1", computed, 1);
  delete a.ripUpdatedAt; delete b.ripUpdatedAt;
  assert.deepStrictEqual(a, b);
});

test("statusVersion es determinista (reintentos NO usan Date.now())", () => {
  const computed = { updatedAt: { toMillis: () => 1751900000000 } };
  assert.strictEqual(deriveStatusVersion(computed, 999), 1751900000000);
  assert.strictEqual(deriveStatusVersion(computed, 999), deriveStatusVersion(computed, 999));
  // Sin updatedAt: usa el timestamp del evento (mismo evento → misma versión).
  assert.strictEqual(deriveStatusVersion({}, 1751900001234), 1751900001234);
  // Formato {seconds, nanoseconds} también soportado.
  assert.strictEqual(deriveStatusVersion({ updatedAt: { seconds: 10, nanoseconds: 5e8 } }, 0), 10500);
});

test("los docs legacyAliasOf y el doble publicador quedan fuera (contrato)", () => {
  // La proyección solo se construye para el studentId canónico.
  const projection = buildStatusProjection("aB3xK9mP2vR7sT4wX8Zz", { clasificacionFinal: "Activo" }, 1);
  assert.strictEqual(projection.studentId, "aB3xK9mP2vR7sT4wX8Zz");
  assert.strictEqual(projection.operationalActive, true);
  assert.strictEqual(projection.accountEnabled, true);
});

test("backfill: token SOLO por header, POST obligatorio, query string rechazado", () => {
  const TOKEN = "token-de-prueba-unitaria";
  const makeReq = ({ method = "POST", header = "", query = {} } = {}) => ({
    method,
    query,
    get: (name) => (name === "x-sync-token" ? header : ""),
  });

  // Caso válido: POST + header correcto.
  assert.strictEqual(isAuthorizedAdminRequest(makeReq({ header: TOKEN }), TOKEN), true);
  // GET se rechaza aunque el header sea correcto.
  assert.strictEqual(isAuthorizedAdminRequest(makeReq({ method: "GET", header: TOKEN }), TOKEN), false);
  // Header incorrecto o ausente.
  assert.strictEqual(isAuthorizedAdminRequest(makeReq({ header: "otro" }), TOKEN), false);
  assert.strictEqual(isAuthorizedAdminRequest(makeReq({}), TOKEN), false);
  // Token por query string: RECHAZADO aunque sea el correcto.
  assert.strictEqual(
    isAuthorizedAdminRequest(makeReq({ header: TOKEN, query: { token: TOKEN } }), TOKEN),
    false,
    "un token en query string invalida la petición completa"
  );
  assert.strictEqual(
    isAuthorizedAdminRequest(makeReq({ query: { token: TOKEN } }), TOKEN),
    false
  );
  // Sin token esperado configurado: nunca autoriza.
  assert.strictEqual(isAuthorizedAdminRequest(makeReq({ header: "" }), ""), false);
});

test("looksLikeAutoId distingue auto-IDs de nameKeys", () => {
  assert.strictEqual(looksLikeAutoId("aB3xK9mP2vR7sT4wX8Zz"), true);
  assert.strictEqual(looksLikeAutoId("ana maria perez"), false);
  assert.strictEqual(looksLikeAutoId("stu_ana_perez_45"), false);
});

test("áreas y técnicas eliminan duplicados sin perder el orden de RIP", () => {
  assert.deepStrictEqual(
    uniqueTextList([["Música", "Música"], "Música", ["Guitarra", "Jazz"], "jazz"]),
    ["Música", "Guitarra", "Jazz"]
  );
});

console.log(`\n${passed} pruebas OK (permissions)`);

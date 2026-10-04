"use strict";

const assert = require("node:assert/strict");
const report = require("../report");

const dossier = "# Expediente\n- Bitácora 1: escalas mayores y arpegios en el piano.";

// Acceso
assert.equal(report.resolveAccess(null, ["s1"]).allowed, false);
assert.equal(report.resolveAccess({ role: "admin" }, ["cualquiera"]).kind, "admin");
assert.equal(report.resolveAccess({ role: "Administradora", active: false }, ["s1"]).allowed, false);
assert.equal(report.resolveAccess({ role: "acudiente", studentIds: ["s1", "s2"] }, ["x", "s2"]).studentId, "s2");
assert.equal(report.resolveAccess({ role: "estudiante", studentIds: ["s1"] }, ["s9"]).allowed, false);
assert.equal(report.resolveAccess({ role: "student", studentId: "s1" }, ["s1"]).allowed, true);
assert.equal(report.resolveAccess({ role: "docente" }, ["s1"]).allowed, false);

// Validación
assert.ok(report.validateRequest({ dossier }).error);
assert.ok(report.validateRequest({ studentId: "a/b", dossier }).error);
assert.ok(report.validateRequest({ studentId: "s1", dossier: "corto" }).error);
assert.ok(report.validateRequest({ studentId: "s1", dossier: "x".repeat(report.MAX_DOSSIER_CHARS + 1) }).error);
assert.deepEqual(report.validateRequest({ studentId: "a", studentIds: ["b", "a", "c/d"], dossier }).studentIds, ["a", "b"]);
const ok = report.validateRequest({ studentId: "s1", dossier, tone: "hackeo" });
assert.equal(ok.tone, "tecnico");
assert.equal(report.validateRequest({ studentId: "s1", dossier, tone: "sencillo" }).tone, "sencillo");

// Prompt: la instrucción de tono viene del servidor y el expediente va delimitado
assert.match(report.buildSystemInstruction("sencillo"), /lenguaje sencillo/);
assert.match(report.buildUserPrompt({ dossier, periodLabel: "el último mes" }), /<expediente>[\s\S]*escalas[\s\S]*<\/expediente>/);

// Limpieza de salida
assert.equal(report.cleanModelOutput("```markdown\n# Hola\n```"), "# Hola");
assert.equal(report.cleanModelOutput("# Hola"), "# Hola");

// Límite diario por día de Bogotá
assert.equal(report.usageDocId("u1", new Date("2026-10-05T03:00:00Z")), "u1_2026-10-04");

console.log("report.test.js: ok");

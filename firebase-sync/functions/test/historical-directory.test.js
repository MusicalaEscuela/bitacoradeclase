"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildHistoricalDirectory, normalizeText } = require("../historical-directory");

test("normaliza nombres con tildes de la misma manera en todos los directorios", () => {
  assert.equal(normalizeText("  Gregorio  Arciniegas Sánchez "), "gregorio arciniegas sanchez");
});

test("no complementa una identidad ya cubierta por studentId canónico", () => {
  const result = buildHistoricalDirectory(
    [{ id: "canonical-1", studentName: "Ana Musicala" }],
    [{ id: "canonical-1", nombre: "Ana Musicala" }]
  );
  assert.equal(result.students.length, 0);
});

test("no complementa una coincidencia única por nombre normalizado", () => {
  const result = buildHistoricalDirectory(
    [{ id: "source-1", studentName: "María José" }],
    [{ id: "legacy-1", nombre: "Maria Jose" }]
  );
  assert.equal(result.students.length, 0);
});

test("incluye en solo lectura una identidad histórica ausente", () => {
  const result = buildHistoricalDirectory(
    [{ id: "source-1", studentName: "Otra Persona" }],
    [{
      id: "stu_gregorio_arciniegas_sanchez_1187",
      nombre: "Gregorio Arciniegas Sánchez",
      email: "gregorio@example.com",
      processes: [{ area: "Música", instrumento: "Bajo" }],
    }]
  );
  assert.equal(result.students.length, 1);
  assert.equal(result.students[0].studentName, "Gregorio Arciniegas Sánchez");
  assert.equal(result.students[0].instrument, "Bajo");
  assert.equal(result.students[0]._readOnly, true);
  assert.match(result.students[0].recordOrigin, /solo lectura/i);
});

test("no fusiona homónimos sin evidencia y los marca para revisión", () => {
  const result = buildHistoricalDirectory([], [
    { id: "legacy-a", nombre: "Juan Pérez", email: "uno@example.com" },
    { id: "legacy-b", nombre: "Juan Perez", email: "dos@example.com" },
  ]);
  assert.equal(result.students.length, 2);
  assert.equal(result.counts.pendingIdentityReview, 2);
  assert.ok(result.students.every((student) => student.identityResolutionStatus === "pending"));
});

test("no devuelve celdas históricas gigantes ni campos no permitidos", () => {
  const huge = "dato ".repeat(2000);
  const result = buildHistoricalDirectory([], [{
    id: "legacy-safe",
    nombre: "Registro Seguro",
    direccion_de_residencia_estudiante: huge,
    interesesMusicales: huge,
  }]);
  assert.equal(result.students.length, 1);
  assert.equal(result.students[0].interests, "");
  assert.equal("direccion_de_residencia_estudiante" in result.students[0], false);
});

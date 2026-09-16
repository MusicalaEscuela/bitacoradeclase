import assert from "node:assert/strict";
import {
  bitacoraBelongsToStudent,
  bitacoraMatchesStudentProcess,
  consumePendingClasses,
  getBitacoraParticipantIds,
} from "../js/utils/bitacora-coverage.js";

const groupLog = {
  id: "grupo-1",
  mode: "group",
  fechaClase: "2026-07-25",
  studentId: "ana",
  primaryStudentId: "ana",
  studentIds: ["ana", "luis", "maria"],
  studentRefs: [
    { id: "ana", name: "Ana" },
    { id: "luis", name: "Luis" },
    { id: "maria", name: "María" },
  ],
  process: { processKey: "piano" },
  studentOverrides: {
    ana: { processKey: "piano" },
    luis: { processKey: "guitarra" },
    maria: { processKey: "violin" },
  },
};

assert.deepEqual(getBitacoraParticipantIds(groupLog), ["ana", "luis", "maria"]);
assert.equal(bitacoraBelongsToStudent(groupLog, "ana"), true);
assert.equal(bitacoraBelongsToStudent(groupLog, "luis"), true);
assert.equal(bitacoraBelongsToStudent(groupLog, "maria"), true);
assert.equal(bitacoraBelongsToStudent(groupLog, "otro"), false);

assert.equal(
  bitacoraMatchesStudentProcess(groupLog, {
    studentIds: ["ana"],
    processKey: "piano",
  }),
  true
);
assert.equal(
  bitacoraMatchesStudentProcess(groupLog, {
    studentIds: ["luis"],
    processKey: "guitarra",
  }),
  true
);
assert.equal(
  bitacoraMatchesStudentProcess(groupLog, {
    studentIds: ["luis"],
    processKey: "piano",
  }),
  false
);

const legacyGroup = {
  ...groupLog,
  id: "grupo-antiguo",
  studentOverrides: {},
};
assert.equal(
  bitacoraMatchesStudentProcess(legacyGroup, {
    studentIds: ["luis"],
    processKey: "guitarra",
  }),
  true,
  "Una grupal histórica no debe desaparecer para un integrante secundario"
);

const legacyPianoLog = {
  studentId: "emma",
  studentIds: ["emma"],
  process: {
    processKey: "proc_emma_musica_piano_legacy",
    processLabel: "Música - Piano",
    area: "Música",
  },
};
assert.equal(
  bitacoraMatchesStudentProcess(legacyPianoLog, {
    studentIds: ["emma"],
    processKey: "proc_emma_musica_piano_actual",
    processDetails: ["Piano", "Música - Piano", "Música"],
  }),
  true,
  "Un cambio técnico de clave no debe ocultar el historial del mismo Piano"
);
assert.equal(
  bitacoraMatchesStudentProcess(legacyPianoLog, {
    studentIds: ["emma"],
    processKey: "proc_emma_musica_canto_actual",
    processDetails: ["Canto", "Música - Canto", "Música"],
  }),
  false,
  "El área genérica no debe mezclar procesos distintos"
);

const pendingResult = consumePendingClasses(
  [
    { studentId: "ana", fechaClase: "2026-07-25" },
    { studentId: "luis", fechaClase: "2026-07-25" },
    { studentId: "maria", fechaClase: "2026-07-25" },
    { studentId: "luis", fechaClase: "2026-07-25" },
  ],
  [groupLog]
);

assert.equal(pendingResult.completed.length, 3);
assert.equal(pendingResult.pending.length, 1);
assert.equal(pendingResult.pending[0].studentId, "luis");

console.log("bitacora-coverage: 14 assertions passed");

"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "code.gs"), "utf8");

function makeContext() {
  const context = {
    console: { log() {}, error() {} },
    Utilities: { getUuid: () => "11111111-2222-3333-4444-555555555555", sleep() {} },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: {},
    UrlFetchApp: {},
    CacheService: {},
    PropertiesService: {},
    ScriptApp: {},
    MailApp: {},
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

function successfulBatch(rows) {
  return {
    processed: rows.length,
    created: 0,
    updated: 0,
    noOp: rows.length * 2,
    errors: 0,
    students: { created: 0, updated: 0, noOp: rows.length, errors: 0 },
    users: { created: 0, updated: 0, noOp: rows.length, errors: 0 },
    firestoreReadMs: 2,
    buildMs: 1,
    writeMs: 0,
    firestoreReadCalls: 2,
    firestoreWriteCalls: 0,
    budgetReached: false,
  };
}

// 1. Guarda el cursor sin avanzar cuando se alcanza el presupuesto interno.
{
  const context = makeContext();
  let cursor = { sheet: "Inscripcion estudiantes", nextRow: 12, runId: "run-budget", updatedAt: "2026-07-12T00:00:00.000Z", cycleState: "running" };
  let saves = 0;
  context.loadSyncCursor_ = () => cursor;
  context.loadSyncControl_ = () => null;
  context.getStudentSheetForSync_ = () => ({});
  context.readStudentRowsBatch_ = () => ({ sheetName: cursor.sheet, lastRow: 30, rows: [{ rowNumber: 12, values: [] }] });
  context.processStudentRowsBatch_ = () => ({ ...successfulBatch([]), budgetReached: true });
  context.saveSyncCursor_ = (value) => { cursor = value; saves += 1; };
  context.saveSyncBatchReport_ = () => {};
  const report = context.syncAllSheetsToFirestore();
  assert.strictEqual(report.status, "partial");
  assert.strictEqual(report.errorCode, "BUDGET_REACHED_BEFORE_WRITE");
  assert.strictEqual(report.cursorAfter.nextRow, 12);
  assert.strictEqual(saves, 1);
  assert.strictEqual(context.isSyncBudgetReached_(0, 209999, 240000, 30000), false);
  assert.strictEqual(context.isSyncBudgetReached_(0, 210000, 240000, 30000), true);
}

// 2 y 3. Reanuda desde la fila siguiente y no repite filas completadas.
{
  const context = makeContext();
  let cursor = { sheet: "Inscripcion estudiantes", nextRow: 2, runId: "run-resume", updatedAt: "2026-07-12T00:00:00.000Z", cycleState: "running" };
  const starts = [];
  const processedRows = [];
  context.loadSyncCursor_ = () => cursor;
  context.loadSyncControl_ = () => null;
  context.getStudentSheetForSync_ = () => ({});
  context.readStudentRowsBatch_ = (sheet, startRow) => {
    starts.push(startRow);
    const rows = startRow === 2
      ? [{ rowNumber: 2, values: [] }, { rowNumber: 3, values: [] }]
      : [{ rowNumber: 4, values: [] }, { rowNumber: 5, values: [] }];
    return { sheetName: cursor.sheet, lastRow: 5, rows };
  };
  context.processStudentRowsBatch_ = (rows) => {
    rows.forEach((row) => processedRows.push(row.rowNumber));
    return successfulBatch(rows);
  };
  context.saveSyncCursor_ = (value) => { cursor = value; };
  context.saveSyncBatchReport_ = () => {};
  const first = context.syncAllSheetsToFirestore();
  const second = context.syncAllSheetsToFirestore();
  assert.strictEqual(first.cursorAfter.nextRow, 4);
  assert.deepStrictEqual(starts, [2, 4]);
  assert.deepStrictEqual(processedRows, [2, 3, 4, 5]);
  assert.strictEqual(new Set(processedRows).size, processedRows.length);
  assert.strictEqual(second.status, "completed");
}

// 4. LockService impide que el procesador se ejecute en paralelo.
{
  const context = makeContext();
  let processorCalls = 0;
  let storedReport = null;
  context.LockService = { getScriptLock: () => ({ tryLock: () => false, releaseLock() {} }) };
  context.processStudentRowsBatch_ = () => { processorCalls += 1; };
  context.saveSyncBatchReport_ = (report) => { storedReport = report; };
  const report = context.syncAllSheetsToFirestore();
  assert.strictEqual(processorCalls, 0);
  assert.strictEqual(report.status, "failed");
  assert.strictEqual(report.errorCode, "LOCK_BUSY");
  assert.strictEqual(storedReport.errorCode, "LOCK_BUSY");
}

// 5. Una ejecucion parcial produce el contrato tecnico completo.
{
  const context = makeContext();
  const cursor = { sheet: "Inscripcion estudiantes", nextRow: 2, runId: "run-partial", updatedAt: "2026-07-12T00:00:00.000Z", cycleState: "running" };
  let stored = null;
  context.loadSyncCursor_ = () => cursor;
  context.loadSyncControl_ = () => null;
  context.getStudentSheetForSync_ = () => ({});
  context.readStudentRowsBatch_ = () => ({ sheetName: cursor.sheet, lastRow: 10, rows: [{ rowNumber: 2, values: [] }] });
  context.processStudentRowsBatch_ = successfulBatch;
  context.saveSyncCursor_ = () => {};
  context.saveSyncBatchReport_ = (report) => { stored = report; };
  const report = context.syncAllSheetsToFirestore();
  ["status", "runId", "processed", "created", "updated", "noOp", "errors", "cursorBefore", "cursorAfter", "durationMs", "errorCode"]
    .forEach((key) => assert.ok(Object.prototype.hasOwnProperty.call(report, key)));
  assert.strictEqual(report.status, "partial");
  assert.strictEqual(stored.runId, "run-partial");
}

// 6. El ultimo lote deja el cursor en estado completed y vuelve a la fila inicial.
{
  const context = makeContext();
  let saved = null;
  const cursor = { sheet: "Inscripcion estudiantes", nextRow: 9, runId: "run-final", updatedAt: "2026-07-12T00:00:00.000Z", cycleState: "running" };
  context.loadSyncCursor_ = () => cursor;
  context.loadSyncControl_ = () => null;
  context.getStudentSheetForSync_ = () => ({});
  context.readStudentRowsBatch_ = () => ({ sheetName: cursor.sheet, lastRow: 9, rows: [{ rowNumber: 9, values: [] }] });
  context.processStudentRowsBatch_ = successfulBatch;
  context.saveSyncCursor_ = (value) => { saved = value; };
  context.saveSyncBatchReport_ = () => {};
  context.syncAllSheetsToFirestore();
  assert.strictEqual(saved.cycleState, "completed");
  assert.strictEqual(saved.nextRow, 2);
}

// 7 y 9. Un user canonico equivalente es no-op y no recibe updatedAt nuevo.
{
  const context = makeContext();
  const existing = {
    email: "student@example.test",
    studentId: "canonical-id",
    studentKey: "legacy-id",
    studentIds: ["canonical-id", "legacy-id", "10"],
    displayName: "Nombre estable",
    source: "students_sheet_sync",
    sourceRow: 10,
    syncOrigin: "apps_script_trigger",
    updatedAt: "2026-07-01T00:00:00.000Z",
    active: true,
    role: "student",
    studentStatus: "Activo",
  };
  const group = [{ studentKey: "legacy-id", studentId: "canonical-id", sourceRow: 10, nombre: "Nombre estable" }];
  const payload = context.buildManagedUserSyncPayload_(existing, "student@example.test", group);
  const operation = context.buildManagedSyncOperation_("users", "student@example.test", existing, payload, "2026-07-12T00:00:00.000Z");
  assert.strictEqual(operation, null);
  assert.strictEqual(existing.updatedAt, "2026-07-01T00:00:00.000Z");
  ["active", "role", "studentStatus", "status", "statusSource", "permissions"].forEach((field) => {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(payload, field), false);
  });
}

// 8. El alias legado de la hoja no reemplaza el studentId canonico enlazado.
{
  const context = makeContext();
  assert.strictEqual(
    context.selectCanonicalUserStudentId_({ studentId: "canonical-id" }, ["legacy-id", "canonical-id"], "legacy-id"),
    "canonical-id"
  );
}

// 10. El reporte valido no contiene PII y el guard rechaza correos.
{
  const context = makeContext();
  const cursor = { sheet: "Inscripcion estudiantes", nextRow: 2, runId: "technical-run", updatedAt: "2026-07-12T00:00:00.000Z", cycleState: "running" };
  const report = context.createBatchSyncReport_(cursor.runId, cursor, Date.now());
  let persisted = null;
  context.replaceFirestoreDocument_ = (collection, docId, payload) => { persisted = { collection, docId, payload }; };
  assert.doesNotThrow(() => context.assertSyncReportHasNoPii_(report));
  context.saveSyncBatchReport_(report);
  assert.strictEqual(persisted.docId, "sync_students_last_report");
  assert.deepStrictEqual(Object.keys(persisted.payload).sort(), Object.keys(report).sort());
  assert.throws(() => context.assertSyncReportHasNoPii_({ ...report, diagnostic: "student@example.test" }), /SYNC_REPORT_PII_DETECTED/);
}

console.log("10 pruebas OK (Apps Script batch sync)");

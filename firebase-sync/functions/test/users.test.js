"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appsScriptPath = path.join(__dirname, "..", "..", "..", "apps-script", "code.gs");
const source = fs.readFileSync(appsScriptPath, "utf8");
const helperMatch = source.match(/function selectCanonicalUserStudentId_\([\s\S]*?\n\}/);
assert.ok(helperMatch, "falta selectCanonicalUserStudentId_");

const sandbox = {};
vm.runInNewContext(`${helperMatch[0]}; this.selectCanonicalUserStudentId_ = selectCanonicalUserStudentId_;`, sandbox);
const selectCanonical = sandbox.selectCanonicalUserStudentId_;

assert.strictEqual(
  selectCanonical({ studentId: "canonical-id" }, ["legacy-id", "canonical-id"], "legacy-id"),
  "canonical-id",
  "el sync conserva el ID canónico ya enlazado"
);
assert.strictEqual(
  selectCanonical({ studentId: "orphan-id" }, ["legacy-id"], "legacy-id"),
  "legacy-id",
  "un ID no enlazado no se conserva"
);
assert.match(source, /studentId:\s*studentId,\s*\n\s*studentKey:\s*studentKey/);

const syncBlock = source.slice(
  source.indexOf("function syncStudentAccessUsersToFirestore"),
  source.indexOf("function migrateLegacyUsersToEmailDocs")
);
assert.ok(syncBlock.indexOf("selectCanonicalUserStudentId_") < syncBlock.indexOf("hasUserAccessChanges_"));
assert.ok(syncBlock.indexOf("hasUserAccessChanges_") < syncBlock.indexOf("commitFirestoreOperations_(operations)"));

console.log("4 pruebas OK (users)");

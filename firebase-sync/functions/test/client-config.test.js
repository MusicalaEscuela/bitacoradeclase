"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const clientRoot = path.resolve(__dirname, "..", "..", "..", "js");

function listJavaScriptFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? listJavaScriptFiles(fullPath) : (entry.name.endsWith(".js") ? [fullPath] : []);
  });
}

const files = listJavaScriptFiles(clientRoot);
const sources = files.map((file) => ({ file, source: fs.readFileSync(file, "utf8") }));
const config = sources.find((item) => item.file.endsWith(`${path.sep}config.js`)).source;
const app = sources.find((item) => item.file.endsWith(`${path.sep}app.js`)).source;
const settings = sources.find((item) => item.file.endsWith(`${path.sep}settings.view.js`)).source;
const firebaseClient = sources.find((item) => item.file.endsWith(`${path.sep}firebase.client.js`)).source;

assert.ok(files.length > 5, "se esperaban archivos cliente para auditar");
for (const item of sources) {
  assert.ok(!/https?:\/\/script\.google\.com/i.test(item.source), `URL legacy en ${path.basename(item.file)}`);
}
assert.match(config, /const LEGACY_CLIENT_ENDPOINT\s*=\s*""/);
assert.ok(!app.includes("triggerStudentsSyncInBackground"));
assert.ok(!settings.includes("settings-sync-students-btn"));
assert.ok(!settings.includes("settings-sync-student-access-btn"));
assert.ok(!settings.includes("settings-refresh-students-access-btn"));
assert.ok(!settings.includes("syncStudentsFromSheetToFirestore"));
assert.ok(!settings.includes("syncStudentAccessUsersFromSheet"));
assert.match(settings, /subscribeStudentAccessUsers/);
assert.match(firebaseClient, /onSnapshot/);

const activeImports = sources
  .filter((item) => !item.file.endsWith(`${path.sep}uploads.api.js`))
  .some((item) => /from\s+["'][^"']*uploads\.api\.js["']/.test(item.source));
assert.strictEqual(activeImports, false, "uploads legacy no debe estar importado por el frontend activo");

console.log("# 1/1 client legacy URL tests passed");

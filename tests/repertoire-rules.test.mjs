// Run against a disposable emulator loaded with firebase rules/firestore.rules.
// java -Duser.language=en -Duser.country=US -jar <firestore-emulator.jar>
//   --host 127.0.0.1 --port 8186 --project_id demo-repertoire --rules <rules-file>
import assert from 'node:assert/strict';
const host = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8186';
const project = 'demo-repertoire';
const base = `http://${host}/v1/projects/${project}/databases/(default)/documents`;
const resource = `projects/${project}/databases/(default)/documents`;
const encode = v => Array.isArray(v) ? { arrayValue: { values: v.map(encode) } }
  : v && typeof v === 'object' ? { mapValue: { fields: fields(v) } }
  : typeof v === 'boolean' ? { booleanValue: v }
  : typeof v === 'number' ? { integerValue: String(v) }
  : v === null ? { nullValue: null } : { stringValue: String(v) };
const fields = v => Object.fromEntries(Object.entries(v).map(([k, value]) => [k, encode(value)]));
const jwt = email => {
  const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ sub: email, email,
    aud: project, iss: `https://securetoken.google.com/${project}`,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    firebase: { sign_in_provider: 'password' } })}.`;
};
async function request(path, method, body, email = 'owner') {
  return fetch(base + path, { method, headers: { 'Content-Type': 'application/json',
    Authorization: `Bearer ${email === 'owner' ? email : jwt(email)}` },
    body: body === undefined ? undefined : JSON.stringify(body) });
}
let passed = 0;
async function expect(response, status, label) {
  assert.equal(response.status, status, `${label}: ${await response.text()}`);
  passed++;
}
const song = i => ({ nombre: `Canción ${i}`, estado: 'proceso', prioridad: 'media',
  notas: '', fechaInicio: '', fechaLogro: '' });
const payload = items => ({ repertorioEscogido: items.map(x => x.nombre),
  repertoire: items.map(x => x.nombre), repertorioProceso: items,
  repertoireProgress: items, updatedBy: 'profile_repertoire' });
async function seed(id, items = [], extra = {}) {
  await expect(await request('/students/' + id, 'PATCH', { fields: fields({
    nombre: 'Estudiante de prueba', documento: 'IDENTIDAD-INTACTA', estado: 'Activo',
    rip: { showInTeacherLists: true }, ...payload(items), ...extra }) }), 200, 'seed');
}
async function save(id, items, email, extra = {}) {
  const data = { ...payload(items), ...extra };
  return request(':commit', 'POST', { writes: [{ update: {
    name: resource + '/students/' + id, fields: fields(data) },
    updateMask: { fieldPaths: Object.keys(data) },
    updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
    currentDocument: { exists: true } }] }, email);
}
for (const [email, profile] of Object.entries({
  'admin@test.invalid': { role: 'admin' }, 'teacher@test.invalid': { role: 'teacher' },
  'inactive@test.invalid': { role: 'admin', active: false },
  'family@test.invalid': { role: 'student', studentIds: ['visible'] },
})) await expect(await request('/users/' + email, 'PATCH', { fields: fields(profile) }), 200, 'profile');

// Add, edit, reorder, and remove one song at a time with a full 20-song list.
for (const role of ['admin', 'teacher']) {
  const email = `${role}@test.invalid`, id = role;
  await seed(id);
  let items = [];
  for (let i = 0; i < 20; i++) {
    items.push(song(i));
    await expect(await save(id, items, email), 200, `${role} add ${i + 1}`);
  }
  items[19] = { ...items[19], nombre: 'Ñ🎵\nNombre', notas: 'N'.repeat(4000),
    estado: 'lograda', fechaInicio: '2026-10-10', fechaLogro: '2026-10-11' };
  await expect(await save(id, items, email), 200, `${role} edit at capacity`);
  await expect(await save(id, [...items, song(20)], email), 403, '21 songs denied');
  await expect(await save(id, [...items].reverse(), email), 200, 'reorder');
  await expect(await save(id, items.slice(1), email), 200, 'remove');
}

// Every malformed NEW/EDITED item must still be rejected. Existing songs survive.
const valid = Array.from({ length: 19 }, (_, i) => song(i));
await seed('visible', valid);
for (const role of ['admin', 'teacher']) {
  const email = `${role}@test.invalid`;
  for (const bad of [
    { nombre: '' }, { nombre: 'x'.repeat(301) }, { nombre: 5 },
    { estado: 'inventado' }, { prioridad: 'urgente' },
    { notas: 'x'.repeat(4001) }, { notas: {} }, { fechaInicio: '10/10/2026' },
    { fechaLogro: '2026-1-1' }, { fechaInicio: null }, { campoAjeno: 'no' },
  ]) await expect(await save('visible', [...valid, { ...song(19), ...bad }], email), 403, 'invalid item');
  const missing = song(19); delete missing.notas;
  await expect(await save('visible', [...valid, missing], email), 403, 'missing field');
  await expect(await save('visible', [...valid, song(0)], email), 403, 'duplicate name');
  await expect(await save('visible', [...valid, song(19)], email,
    { repertoire: ['desincronizado'] }), 403, 'bilingual mismatch');
  await expect(await save('visible', [...valid, song(19)], email,
    { documento: 'CAMBIADO' }), 403, 'identity protected');
  await expect(await save('visible', [...valid, song(19)], email,
    { updatedBy: 'another_flow' }), 403, 'audit protected');
}
for (const email of ['inactive@test.invalid', 'family@test.invalid', 'outsider@test.invalid'])
  await expect(await save('visible', [...valid, song(19)], email), 403, 'unauthorized');
await seed('hidden', valid, { rip: { showInTeacherLists: false } });
await expect(await save('hidden', [...valid, song(19)], 'teacher@test.invalid'), 403, 'RIP visibility protected');
await expect(await request('/students/new', 'PATCH', { fields: fields(payload([song(0)])) },
  'admin@test.invalid'), 403, 'student creation protected');
await expect(await request('/students/visible', 'DELETE', undefined, 'admin@test.invalid'), 403, 'student deletion protected');

// Shared app boundaries: Docentes HUB does not require a local teacher profile.
await expect(await request('/expected_class_logs/test', 'PATCH', { fields: fields({
  profesorEmail: 'hub@test.invalid' }) }), 200, 'seed HUB');
await expect(await request('/expected_class_logs/test', 'GET', undefined, 'hub@test.invalid'), 200, 'HUB own class');
await expect(await request('/expected_class_logs/test', 'GET', undefined, 'outsider@test.invalid'), 403, 'HUB other class');
await expect(await request('/expected_class_logs/test', 'PATCH', { fields: fields({ profesorEmail: 'hub@test.invalid' }) },
  'hub@test.invalid'), 403, 'HUB backend write protected');
await expect(await request('/student_private_notes/visible', 'PATCH', { fields: fields({ notas: 'Internas' }) },
  'teacher@test.invalid'), 200, 'internal notes team');
await expect(await request('/student_private_notes/visible', 'GET', undefined, 'family@test.invalid'), 403, 'internal notes private');
await expect(await request('/sync_logs/test', 'PATCH', { fields: fields({ origen: 'backend' }) },
  'admin@test.invalid'), 403, 'sync backend only');
await expect(await request('/student_identity_links/test', 'DELETE', undefined,
  'admin@test.invalid'), 403, 'identity links immutable');
console.log(`PASS ${passed} emulator checks: repertoire and shared app permissions.`);

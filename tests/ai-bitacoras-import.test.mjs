import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { validImportDate, resolveImportDate, matchImportStudents, importDocumentId, readAiImportFiles } from '../js/utils/ai-bitacoras-import.js';
const require = createRequire(import.meta.url), ai = require('../functions-ai/import.js');
assert.throws(() => ai.validateRequest({}), /Pega texto/);
assert.throws(() => ai.validateRequest({ text: 'x'.repeat(120001) }), /120.000/);
assert.throws(() => ai.validateRequest({ text: 'clase', year: '2026x' }), /año/);
assert.throws(() => ai.validateRequest({ files: [{ mimeType: 'text/html', data: 'YQ==' }] }), /compatible/);
assert.throws(() => ai.validateRequest({ files: [{ mimeType: 'application/pdf', data: '!' }] }), /compatible/);
assert.throws(() => ai.validateRequest({ files: [{ mimeType: 'application/pdf', data: 'A'.repeat(8 * 1024 * 1024) }] }), /5 MB/);
const classes = [{ label: 'Sesión 2', dateText: '14 de Febrero', day: 14, month: 2, year: 0, time: '16:00', teacher: '', students: [], observations: 'Tema: Postura y coordinación\nSe dio continuidad al trabajo postural incorpor', corporal: [], technical: ['Posiciones básicas'], theoretical: ['Postura organizada'], works: [], warnings: ['Descripción cortada en el original.'] }];
let result = ai.cleanOutput(JSON.stringify({ classes, warnings: [] }), { year: 0, teacher: '' });
assert.equal(result.classes[0].fechaClase, '');
assert.equal(result.classes[0].docente, '');
assert.ok(result.classes[0].tareas.endsWith('incorpor'));
assert.ok(result.classes[0].warnings.some(w => w.includes('cortada')));
result = ai.cleanOutput({ classes, warnings: [] }, { year: 2026, teacher: 'Docente confirmado' });
assert.equal(result.classes[0].fechaClase, '2026-02-14');
assert.equal(result.classes[0].docente, 'Docente confirmado');
assert.equal(ai.dateISO(29, 2, 2026), '');
assert.equal(ai.dateISO(29, 2, 2024), '2024-02-29');
assert.equal(ai.dateISO(32, 3, 2026), '');
assert.equal(validImportDate('2026-02-30'), false);
assert.equal(validImportDate('2026-02-14'), true);
for (const [dateText, expected] of [
  ['7 de Febrero', '2026-02-07'], ['14 de Febrero', '2026-02-14'],
  ['21 de Febrero', '2026-02-21'], ['7 de Marzo', '2026-03-07'],
  ['14 de Marzo', '2026-03-14'], ['28 de Marzo', '2026-03-28'],
  ['11 de Abril', '2026-04-11'], ['18 de Abril', '2026-04-18'],
]) assert.equal(resolveImportDate({dateText}, 2026), expected);
assert.equal(resolveImportDate({dateText:'7 de febrero'}, ''), '');
assert.equal(resolveImportDate({dateText:'7 de febrero de 2025'}, 2026), '2025-02-07');
assert.equal(resolveImportDate({dateText:'2025-02-07'}, 2026), '2025-02-07');
assert.equal(resolveImportDate({dateText:'07/02/2025'}, 2026), '2025-02-07');
assert.equal(resolveImportDate({day:7,month:2,year:2025}, 2026), '2025-02-07');
assert.equal(resolveImportDate({day:7,month:2,year:0,fechaClase:'2026-02-07'}, 2024), '2024-02-07');
assert.equal(resolveImportDate({dateText:'31 de febrero'}, 2026), '');
assert.equal(resolveImportDate({dateText:'29 de febrero'}, 2024), '2024-02-29');
assert.equal(resolveImportDate({dateText:'29 de febrero'}, 2026), '');
assert.throws(() => ai.cleanOutput('respuesta incompleta', { year: 2026 }), SyntaxError);
assert.throws(() => ai.cleanOutput({ classes: Array(41).fill({}) }, {}), /lista válida/);
const students = [{ id: 's1', name: 'Felipe Gómez Iregui' }, { id: 's2', name: 'Ana María Castro' }, { id: 's3', name: 'Ana Lucía Castro' }];
const match = names => matchImportStudents(names, students, students[0], s => s.id, s => s.name);
assert.deepEqual(match(['Felipe Iregui']).linkedStudents.map(s => s.id), ['s1']);
assert.deepEqual(match(['Ana Castro']).unresolvedStudents, ['Ana Castro']);
assert.deepEqual(match(['No Existe']).linkedStudents, []);
assert.deepEqual(match([]).linkedStudents.map(s => s.id), ['s1']);
assert.deepEqual(match(['Felipe Iregui', 'Ana María Castro']).linkedStudents.map(s => s.id), ['s1', 's2']);
const payload = { fechaClase: '2026-02-14', horaClase: '16:00', studentIds: ['s1'], processKey: 'danza', docente: 'Docente', content: 'Postura corporal' };
const id = await importDocumentId(payload);
assert.equal(id, await importDocumentId({ ...payload, metadata: { importedAt: Date.now() } }));
assert.notEqual(id, await importDocumentId({ ...payload, horaClase: '17:00' }));
assert.notEqual(id, await importDocumentId({ ...payload, studentIds: ['s2'] }));
assert.notEqual(id, await importDocumentId({ ...payload, content: 'Otra actividad' }));
await assert.rejects(readAiImportFiles([{ name: 'plan.docx', size: 100 }]), /exporta como PDF/);
console.log('PASS: IA conserva texto y datos ausentes; formatos, fechas, grupos ambiguos y reintentos seguros.');

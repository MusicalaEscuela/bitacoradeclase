import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { deriveMapPianoRouteProgress } from '../js/utils/map-piano-route.js';
const source = fs.readFileSync(new URL('../js/views/profile.view.js', import.meta.url), 'utf8');
function implementation(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const end = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, end < 0 ? source.length : end);
}
const context = vm.createContext({
  Set,
  escapeHtml: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
  firstNonEmpty: (...values) => values.find(Boolean) || '',
  toStringSafe: value => String(value ?? ''),
  compareRouteGoals: (a, b) => a.order - b.order,
  getMapPianoProgress: route => deriveMapPianoRouteProgress(route, route.completedGoalIds),
  getMapPianoCurrentExperience: route => deriveMapPianoRouteProgress(route, route.completedGoalIds).currentExperience,
  renderMapPianoIdentityNotice: () => '',
});
for (const name of ['renderMapPianoGoalControl', 'renderMapComponentGoals', 'renderMapPianoRoutePreview', 'renderMapPianoExperienceCard']) {
  vm.runInContext(implementation(name), context);
}
const experiences = [1, 2, 3].map(order => ({
  id: `e${order}`, order, label: `Experiencia ${order}`, name: `Etapa ${order}`,
  skills: ['tecnica', 'teorico', 'repertorio'].map(component => ({
    id: `${order}-${component}`, component, componentLabel: component, experience: order,
    experienceLabel: `Experiencia ${order}`, title: `${order} ${component}`, achievement: '<Evidencia>', order: 1,
  })),
}));
const completedGoalIds = ['1-tecnica', '1-repertorio'];
const progress = deriveMapPianoRouteProgress({ experiences }, completedGoalIds);
const route = { experiences, completedGoalIds, activeGoalIds: progress.activeGoalIds, currentExperienceId: 'e1', progressIdentityReady: true };
const html = context.renderMapPianoRoutePreview(route, { canUpdateRouteProgress: true });
for (const id of ['2-tecnica', '1-teorico', '2-repertorio']) assert.ok(html.includes(`data-route-goal-check="${id}"`), id);
for (const id of ['3-tecnica', '2-teorico', '3-repertorio']) assert.ok(!html.includes(`data-route-goal-check="${id}"`), id);
assert.ok(html.includes('data-route-goal-undo="1-repertorio"'));
assert.ok(html.includes('&lt;Evidencia>'));
assert.ok(html.includes('Experiencia 2'));
assert.ok(html.includes('avanzan por separado'));
const readonly = context.renderMapPianoRoutePreview(route, {});
assert.equal((readonly.match(/disabled/g) || []).length, 3);
assert.ok(!readonly.includes('data-route-goal-undo='));
const future = context.renderMapPianoExperienceCard(experiences[1], route, true);
assert.ok(future.includes('is-active'));
assert.ok(future.includes('data-route-goal-check="2-repertorio"'));
assert.ok(!future.includes('data-route-goal-check="2-teorico"'));
console.log('map-component-preview: all renderer assertions passed');

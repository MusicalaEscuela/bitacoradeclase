// Sorteo reproducible por estudiante/ruta; semanas de lunes a domingo en Bogotá.
function hash(value) {
  let result = 2166136261;
  for (const char of value) result = Math.imul(result ^ char.codePointAt(0), 16777619);
  return result >>> 0;
}

export function getWeeklyReview({ studentId, routeKey, goals = [], completedGoalIds = [] } = {}, options = {}) {
  if (!studentId || !routeKey) return null;
  const completed = new Set(completedGoalIds);
  const candidates = [...new Map(goals
    .filter((goal) => goal?.id && goal?.title && completed.has(goal.id))
    .map((goal) => [goal.id, goal])).values()];
  if (!candidates.length) return null;
  const now = options.now || new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const datePart = (type) => Number(parts.find((part) => part.type === type).value);
  const date = new Date(Date.UTC(datePart('year'), datePart('month') - 1, datePart('day')));
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  const week = date.toISOString().slice(0, 10);
  const scope = JSON.stringify([String(studentId), String(routeKey)]);
  const cacheKey = (key) => `bitacoras:weekly-review:v1:${scope}:${key}`;
  let storage;
  try { storage = options.storage === undefined ? globalThis.localStorage : options.storage; } catch {}
  let previousId;
  try {
    const savedId = storage?.getItem(cacheKey(week));
    const saved = candidates.find((goal) => goal.id === savedId);
    if (saved) return { goal: saved, week };
    previousId = storage?.getItem(cacheKey(new Date(date.getTime() - 604800000).toISOString().slice(0, 10)));
  } catch {}
  candidates.sort((a, b) => hash(`${scope}:${a.id}`) - hash(`${scope}:${b.id}`) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let index = (Math.floor(date.getTime() / 604800000) + hash(scope)) % candidates.length;
  if (candidates.length > 1 && candidates[index].id === previousId) index = (index + 1) % candidates.length;
  const goal = candidates[index];
  try { storage?.setItem(cacheKey(week), goal.id); } catch {}
  return { goal, week };
}

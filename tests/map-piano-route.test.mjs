import assert from "node:assert/strict";
import {
  adaptPublishedPianoCurriculum,
  adaptPublishedViolinCurriculum,
  deriveMapPianoRouteProgress,
  getMapPianoProgressIdentity,
  isCurrentMapPianoProgressRecord,
  isMapPianoProcess,
  MAP_PIANO_PROGRESS_EPOCH,
  MAP_PIANO_ROUTE_TEMPLATE_ID,
  MAP_VIOLIN_ROUTE_TEMPLATE_ID,
} from "../js/utils/map-piano-route.js";

function buildPublishedCurriculum() {
  const experiences = Array.from({ length: 38 }, (_, index) => {
    const order = index + 1;
    const experienceId = `exp-${String(order).padStart(2, "0")}`;
    return {
      id: experienceId,
      order,
      label: `Experiencia ${order}`,
      name: `Nombre ${order}`,
      objective: `Objetivo ${order}`,
      evidence: `Evidencia ${order}`,
      personalRepertoire: {
        title: `Repertorio ${order}`,
        focus: `Foco ${order}`,
        evidence: `Evidencia de repertorio ${order}`,
      },
      skills: ["tecnica", "teoria"].map((skillId, skillIndex) => ({
        id: skillId,
        goalId: `${experienceId}:${skillId}`,
        component: skillIndex === 0 ? "tecnica" : "teorico",
        category: `Categoría ${skillIndex + 1}`,
        title: `Meta ${order}.${skillIndex + 1}`,
        description: `Descripción ${order}.${skillIndex + 1}`,
        achievement: `Logro ${order}.${skillIndex + 1}`,
      })),
    };
  });

  return {
    schemaVersion: 1,
    routeKey: "piano",
    route: {
      name: "Ruta oficial de Piano",
      description: "Ruta publicada",
      artName: "Música",
    },
    source: {
      projectId: "mapa-de-experiencias",
      slug: "piano",
    },
    experienceCount: experiences.length,
    goalCount: experiences.length * 2,
    experiences,
    revision: `sha256:${"a".repeat(64)}`,
    sourceUpdatedAt: "2026-08-15T00:00:00.000Z",
  };
}

const published = buildPublishedCurriculum();
const route = adaptPublishedPianoCurriculum(published);

assert.equal(route.routeTemplateId, MAP_PIANO_ROUTE_TEMPLATE_ID);
assert.equal(route.progressEpoch, MAP_PIANO_PROGRESS_EPOCH);
assert.equal(route.experiences.length, 38);
assert.equal(route.customGoals.length, 76);
assert.equal(route.customGoals[0].id, "exp-01:tecnica");
assert.equal(route.customGoals[0].goalId, "exp-01:tecnica");
assert.equal(route.customGoals.at(-1).id, "exp-38:teoria");

const violinPublished = {
  ...structuredClone(published),
  routeKey: "violin",
  source: { ...published.source, slug: "violin" },
  route: { ...published.route, name: "Ruta oficial de Violín" },
  experiences: published.experiences.slice(0, 2),
  experienceCount: 2,
  goalCount: 4,
};
const violinRoute = adaptPublishedViolinCurriculum(violinPublished);
assert.equal(violinRoute.routeTemplateId, MAP_VIOLIN_ROUTE_TEMPLATE_ID);
assert.equal(violinRoute.experiences.length, 2);

const invalidPublished = structuredClone(published);
invalidPublished.experiences[0].skills[0].goalId = "meta-inestable";
assert.throws(
  () => adaptPublishedPianoCurriculum(invalidPublished),
  /identidad estable/
);

const invalidSource = structuredClone(published);
invalidSource.source.projectId = "otro-proyecto";
assert.throws(() => adaptPublishedPianoCurriculum(invalidSource), /fuente publicada/);

const invalidOrder = structuredClone(published);
invalidOrder.experiences[1].order = 4;
assert.throws(() => adaptPublishedPianoCurriculum(invalidOrder), /orden/);

const invalidEvidence = structuredClone(published);
invalidEvidence.experiences[0].evidence = "";
assert.throws(() => adaptPublishedPianoCurriculum(invalidEvidence), /objetivo y evidencia/);

assert.equal(
  getMapPianoProgressIdentity({
    canonicalStudentId: "student_official_123",
    identityResolutionStatus: "resolved_official",
  }).ok,
  true
);
assert.equal(
  getMapPianoProgressIdentity({
    canonicalStudentId: "student_official_123",
    identityResolutionStatus: "pending",
  }).reason,
  "pending"
);
assert.equal(
  getMapPianoProgressIdentity({ identityResolutionStatus: "resolved_official" })
    .reason,
  "missing_canonical_id"
);
assert.equal(
  getMapPianoProgressIdentity({
    canonicalStudentId: "stu_legacy_123",
    identityResolutionStatus: "resolved_stu",
  }).reason,
  "historical_alias"
);

const currentProgress = {
  studentId: "student_official_123",
  studentKey: "student_official_123",
  routeTemplateId: MAP_PIANO_ROUTE_TEMPLATE_ID,
  progressEpoch: MAP_PIANO_PROGRESS_EPOCH,
};
assert.equal(
  isCurrentMapPianoProgressRecord(currentProgress, "student_official_123"),
  true
);
assert.equal(
  isCurrentMapPianoProgressRecord(
    { ...currentProgress, progressEpoch: "mapa-piano-prueba-vieja" },
    "student_official_123"
  ),
  false
);
assert.equal(
  isCurrentMapPianoProgressRecord(currentProgress, "stu_legacy_123"),
  false
);

assert.equal(isMapPianoProcess({ detalle: "Piano" }), true);
assert.equal(isMapPianoProcess({ processKey: "piano" }), true);
assert.equal(isMapPianoProcess({ processKey: "musica_teclado_1" }), true);
assert.equal(isMapPianoProcess({ arte: "Piano" }), true);
assert.equal(isMapPianoProcess({ instrumento: "Teclado" }), true);
assert.equal(isMapPianoProcess({ detalle: "Guitarra" }), false);

const zeroProgress = deriveMapPianoRouteProgress(route, []);
assert.equal(zeroProgress.milestones.length, 38);
assert.equal(zeroProgress.currentExperienceId, "exp-01");
assert.equal(zeroProgress.currentExperienceOrder, 1);
assert.equal(zeroProgress.completedGoals, 0);

const futureOnlyProgress = deriveMapPianoRouteProgress(route, [
  "exp-02:tecnica",
  "exp-02:teoria",
]);
assert.equal(
  futureOnlyProgress.currentExperienceId,
  "exp-01",
  "Completar una experiencia futura no debe saltar la primera incompleta"
);

const firstExperienceComplete = deriveMapPianoRouteProgress(route, [
  "exp-01:tecnica",
  "exp-01:teoria",
]);
assert.equal(firstExperienceComplete.currentExperienceId, "exp-02");
assert.deepEqual(firstExperienceComplete.activeGoalIds, [
  "exp-02:tecnica",
  "exp-02:teoria",
]);

const allGoalIds = route.customGoals.map((goal) => goal.id);
const completeProgress = deriveMapPianoRouteProgress(route, allGoalIds);
assert.equal(completeProgress.isComplete, true);
assert.equal(completeProgress.currentExperience, null);
assert.equal(completeProgress.percent, 100);

console.log("map-piano-route: 34 assertions passed");

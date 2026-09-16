export const MAP_PIANO_ROUTE_TEMPLATE_ID = "mapa-piano";
export const MAP_PIANO_PROGRESS_EPOCH = "mapa-piano-20260815-v1";
export const MAP_PIANO_CURRICULUM_COLLECTION = "published_curricula";
export const MAP_PIANO_CURRICULUM_DOCUMENT = "piano";
export const MAP_GUITAR_ROUTE_TEMPLATE_ID = "mapa-guitarra";
export const MAP_GUITAR_PROGRESS_EPOCH = "mapa-guitarra-20260831-v1";
export const MAP_GUITAR_CURRICULUM_DOCUMENT = "guitarra";
export const MAP_VIOLIN_ROUTE_TEMPLATE_ID = "mapa-violin";
export const MAP_VIOLIN_PROGRESS_EPOCH = "mapa-violin-20260831-v1";
export const MAP_VIOLIN_CURRICULUM_DOCUMENT = "violin";

const MAP_PIANO_SCHEMA_VERSION = 1;

const MAP_GUITAR_CONFIG = Object.freeze({
  documentId: MAP_GUITAR_CURRICULUM_DOCUMENT,
  routeTemplateId: MAP_GUITAR_ROUTE_TEMPLATE_ID,
  progressEpoch: MAP_GUITAR_PROGRESS_EPOCH,
  label: "Guitarra",
  pattern: /(^|[^a-z0-9])(guitarra|guitar)([^a-z0-9]|$)/,
});
const MAP_VIOLIN_CONFIG = Object.freeze({
  documentId: MAP_VIOLIN_CURRICULUM_DOCUMENT,
  routeTemplateId: MAP_VIOLIN_ROUTE_TEMPLATE_ID,
  progressEpoch: MAP_VIOLIN_PROGRESS_EPOCH,
  label: "Violín",
  pattern: /(^|[^a-z0-9])(violin|violinista)([^a-z0-9]|$)/,
});

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function normalizedText(value) {
  return text(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function componentDetails(value) {
  const component = normalizedText(value).replace(/[^a-z0-9]+/g, "-");
  if (component === "tecnica" || component === "tecnico") {
    return { id: "tecnica", label: "Técnica" };
  }
  if (component === "teorico" || component === "teoria") {
    return { id: "teorico", label: "Teórico" };
  }
  if (component === "repertorio" || component === "obras") {
    return { id: "repertorio", label: "Repertorio" };
  }
  return {
    id: component || "general",
    label: text(value) || "General",
  };
}

function curriculumError(message, details = {}) {
  const error = new Error(message);
  error.code = "INVALID_MAP_PIANO_CURRICULUM";
  Object.assign(error, details);
  return error;
}

function normalizePersonalRepertoire(value = {}) {
  if (!value || typeof value !== "object") {
    return { title: "", focus: "", evidence: "" };
  }
  return {
    title: text(value.title),
    focus: text(value.focus),
    evidence: text(value.evidence),
  };
}

export function isMapPianoProcess(process = null) {
  return isMapCurriculumProcess(process, { pattern: /(^|[^a-z0-9])(piano|teclado)([^a-z0-9]|$)/ });
}

export function isMapGuitarProcess(process = null) {
  return isMapCurriculumProcess(process, MAP_GUITAR_CONFIG);
}

export function isMapViolinProcess(process = null) {
  return isMapCurriculumProcess(process, MAP_VIOLIN_CONFIG);
}

function isMapCurriculumProcess(process = null, config = {}) {
  if (!process || typeof process !== "object") return false;
  const hint = [
    process.detalle,
    process.instrumento,
    process.instrument,
    process.label,
    process.programa,
    process.arte,
    process.area,
    process.processKey,
    process.artKey,
  ]
    .map(normalizedText)
    .filter(Boolean)
    .join(" ");
  return config.pattern.test(hint);
}

export function getMapPianoProgressIdentity(student = {}) {
  return getMapCurriculumProgressIdentity(student);
}

export function getMapGuitarProgressIdentity(student = {}) {
  return getMapCurriculumProgressIdentity(student);
}

export function getMapViolinProgressIdentity(student = {}) {
  return getMapCurriculumProgressIdentity(student);
}

function getMapCurriculumProgressIdentity(student = {}) {
  const canonicalStudentId = text(student?.canonicalStudentId);
  const resolutionStatus = normalizedText(student?.identityResolutionStatus);

  if (resolutionStatus === "pending") {
    return {
      ok: false,
      studentId: "",
      reason: "pending",
      message:
        "La identidad canónica de este estudiante está pendiente de revisión. La ruta se puede consultar, pero el avance no se guardará todavía.",
    };
  }

  if (!canonicalStudentId) {
    return {
      ok: false,
      studentId: "",
      reason: "missing_canonical_id",
      message:
        "Este estudiante aún no tiene un ID canónico explícito. La ruta se puede consultar, pero el avance está bloqueado para proteger su identidad.",
    };
  }

  if (/^stu_/i.test(canonicalStudentId)) {
    return {
      ok: false,
      studentId: "",
      reason: "historical_alias",
      message:
        "Este perfil todavía usa un alias académico histórico. Debe vincularse a su ID canónico antes de guardar avances.",
    };
  }

  return {
    ok: true,
    studentId: canonicalStudentId,
    reason: "canonical",
    message: "",
  };
}

export function isMapPianoRoute(route = {}) {
  return isMapCurriculumRoute(route, MAP_PIANO_ROUTE_TEMPLATE_ID);
}

export function isMapGuitarRoute(route = {}) {
  return isMapCurriculumRoute(route, MAP_GUITAR_ROUTE_TEMPLATE_ID);
}

export function isMapViolinRoute(route = {}) {
  return isMapCurriculumRoute(route, MAP_VIOLIN_ROUTE_TEMPLATE_ID);
}

export function isMapCurriculumRoute(route = {}, routeTemplateId = "") {
  return (
    route?.managedByMap === true &&
    text(route?.routeTemplateId) === routeTemplateId
  );
}

export function isCurrentMapPianoProgressRecord(
  progress = {},
  canonicalStudentId = ""
) {
  return isCurrentMapCurriculumProgressRecord(progress, canonicalStudentId, {
    routeTemplateId: MAP_PIANO_ROUTE_TEMPLATE_ID,
    progressEpoch: MAP_PIANO_PROGRESS_EPOCH,
  });
}

export function isCurrentMapGuitarProgressRecord(progress = {}, canonicalStudentId = "") {
  return isCurrentMapCurriculumProgressRecord(progress, canonicalStudentId, MAP_GUITAR_CONFIG);
}

export function isCurrentMapViolinProgressRecord(progress = {}, canonicalStudentId = "") {
  return isCurrentMapCurriculumProgressRecord(progress, canonicalStudentId, MAP_VIOLIN_CONFIG);
}

export function isCurrentMapCurriculumProgressRecord(progress = {}, canonicalStudentId = "", config = {}) {
  const safeStudentId = text(canonicalStudentId);
  if (!safeStudentId || /^stu_/i.test(safeStudentId)) return false;
  return (
    text(progress?.studentId) === safeStudentId &&
    text(progress?.studentKey) === safeStudentId &&
    text(progress?.routeTemplateId) === text(config.routeTemplateId) &&
    text(progress?.progressEpoch) === text(config.progressEpoch)
  );
}

export function adaptPublishedPianoCurriculum(payload = {}) {
  if (Number(payload?.schemaVersion) !== MAP_PIANO_SCHEMA_VERSION) {
    throw curriculumError("La versión publicada de la ruta de Piano no es compatible.");
  }
  if (text(payload?.routeKey) !== "piano") {
    throw curriculumError("El documento publicado no corresponde a la ruta de Piano.");
  }
  if (
    text(payload?.source?.projectId) !== "mapa-de-experiencias" ||
    text(payload?.source?.slug) !== "piano"
  ) {
    throw curriculumError("La fuente publicada de la ruta de Piano no es válida.");
  }
  if (!Array.isArray(payload?.experiences) || !payload.experiences.length) {
    throw curriculumError("La ruta publicada de Piano no contiene experiencias.");
  }
  if (
    !Number.isInteger(Number(payload?.experienceCount)) ||
    Number(payload.experienceCount) <= 0 ||
    !Number.isInteger(Number(payload?.goalCount)) ||
    Number(payload.goalCount) <= 0
  ) {
    throw curriculumError(
      "La ruta publicada de Piano no declara totales válidos de experiencias y metas."
    );
  }
  if (!/^sha256:[a-f0-9]{64}$/i.test(text(payload?.revision))) {
    throw curriculumError("La ruta publicada de Piano no tiene una revisión válida.");
  }

  const seenExperienceIds = new Set();
  const seenExperienceOrders = new Set();
  const seenGoalIds = new Set();
  const experiences = payload.experiences
    .map((experience, experienceIndex) => {
      const experienceId = text(experience?.id);
      if (!experienceId || seenExperienceIds.has(experienceId)) {
        throw curriculumError("La ruta publicada contiene una experiencia sin ID único.", {
          experienceId,
        });
      }
      seenExperienceIds.add(experienceId);

      const experienceOrder = Number(experience?.order);
      if (
        !Number.isInteger(experienceOrder) ||
        experienceOrder <= 0 ||
        seenExperienceOrders.has(experienceOrder)
      ) {
        throw curriculumError(
          "La ruta publicada contiene un orden de experiencia inválido o repetido.",
          { experienceId, experienceOrder }
        );
      }
      seenExperienceOrders.add(experienceOrder);
      const experienceLabel =
        text(experience?.label) || `Experiencia ${experienceOrder}`;
      const experienceName = text(experience?.name) || experienceLabel;
      const objective = text(experience?.objective);
      const evidence = text(experience?.evidence);
      if (!objective || !evidence) {
        throw curriculumError(
          "Cada experiencia publicada de Piano debe incluir objetivo y evidencia.",
          { experienceId }
        );
      }
      if (!Array.isArray(experience?.skills) || !experience.skills.length) {
        throw curriculumError(
          "Cada experiencia publicada de Piano debe incluir al menos una meta.",
          { experienceId }
        );
      }
      const skills = experience.skills.map(
        (skill, skillIndex) => {
          const skillId = text(skill?.id);
          const goalId = text(skill?.goalId);
          const expectedGoalId = `${experienceId}:${skillId}`;
          if (!skillId || goalId !== expectedGoalId || seenGoalIds.has(goalId)) {
            throw curriculumError(
              "La ruta publicada contiene una meta sin identidad estable.",
              { experienceId, skillId, goalId, expectedGoalId }
            );
          }
          seenGoalIds.add(goalId);
          const component = componentDetails(skill?.component);
          return {
            id: goalId,
            goalId,
            skillId,
            experienceId,
            experience: experienceOrder,
            experienceOrder,
            experienceLabel,
            experienceName,
            component: component.id,
            componentLabel: component.label,
            section: experienceName,
            category: text(skill?.category),
            title: text(skill?.title) || `Meta ${skillIndex + 1}`,
            description: text(skill?.description),
            achievement: text(skill?.achievement),
            difficulty: text(skill?.difficulty),
            note: text(skill?.note),
            order: skillIndex + 1,
            managedByMap: true,
          };
        }
      );

      return {
        id: experienceId,
        order: experienceOrder,
        label: experienceLabel,
        name: experienceName,
        difficulty: text(experience?.difficulty),
        estimatedDuration: text(experience?.estimatedDuration),
        suggestedAge: text(experience?.suggestedAge),
        description: text(experience?.description),
        objective,
        prerequisites: text(experience?.prerequisites),
        prerequisiteExperienceIds: Array.isArray(
          experience?.prerequisiteExperienceIds
        )
          ? experience.prerequisiteExperienceIds.map(text).filter(Boolean)
          : [],
        evidence,
        personalRepertoire: normalizePersonalRepertoire(
          experience?.personalRepertoire
        ),
        skills,
      };
    })
    .sort((left, right) => left.order - right.order);

  if (experiences.some((experience, index) => experience.order !== index + 1)) {
    throw curriculumError(
      "Los órdenes publicados de las experiencias de Piano deben ser contiguos desde 1."
    );
  }

  const goals = experiences.flatMap((experience) => experience.skills);
  if (Number(payload.experienceCount) !== experiences.length) {
    throw curriculumError("El total publicado de experiencias no coincide con su contenido.");
  }
  if (Number(payload.goalCount) !== goals.length) {
    throw curriculumError("El total publicado de metas no coincide con su contenido.");
  }

  const experienceDescriptions = Object.fromEntries(
    experiences.map((experience) => [
      String(experience.order),
      experience.objective || experience.description,
    ])
  );

  return {
    managedByMap: true,
    curriculumSource: "mapa-de-experiencias",
    schemaVersion: MAP_PIANO_SCHEMA_VERSION,
    routeTemplateId: MAP_PIANO_ROUTE_TEMPLATE_ID,
    progressEpoch: MAP_PIANO_PROGRESS_EPOCH,
    presetId: MAP_PIANO_ROUTE_TEMPLATE_ID,
    routeName: text(payload?.route?.name) || "Ruta de Piano",
    routeDescription: text(payload?.route?.description),
    artName: text(payload?.route?.artName),
    revision: text(payload?.revision),
    source: payload?.source && typeof payload.source === "object" ? payload.source : {},
    sourceUpdatedAt: payload?.sourceUpdatedAt || null,
    publishedAt: payload?.publishedAt || null,
    experienceCount: experiences.length,
    goalCount: goals.length,
    experiences,
    goals,
    customGoals: goals,
    experienceDescriptions,
  };
}

// El esquema público es idéntico; se adapta con el mismo validador estricto y
// se restaura la identidad de Guitarra antes de que llegue a la interfaz.
export function adaptPublishedGuitarCurriculum(payload = {}) {
  const adapted = adaptPublishedPianoCurriculum({
    ...payload,
    routeKey: "piano",
    source: { ...(payload?.source || {}), slug: "piano" },
  });
  return {
    ...adapted,
    routeTemplateId: MAP_GUITAR_ROUTE_TEMPLATE_ID,
    progressEpoch: MAP_GUITAR_PROGRESS_EPOCH,
    presetId: MAP_GUITAR_ROUTE_TEMPLATE_ID,
    routeName: text(payload?.route?.name) || "Ruta de Guitarra",
    source: payload?.source && typeof payload.source === "object" ? payload.source : {},
  };
}

export function adaptPublishedViolinCurriculum(payload = {}) {
  const adapted = adaptPublishedPianoCurriculum({
    ...payload,
    routeKey: "piano",
    source: { ...(payload?.source || {}), slug: "piano" },
  });
  return {
    ...adapted,
    routeTemplateId: MAP_VIOLIN_ROUTE_TEMPLATE_ID,
    progressEpoch: MAP_VIOLIN_PROGRESS_EPOCH,
    presetId: MAP_VIOLIN_ROUTE_TEMPLATE_ID,
    routeName: text(payload?.route?.name) || "Ruta de Violín",
    source: payload?.source && typeof payload.source === "object" ? payload.source : {},
  };
}

export function deriveMapPianoRouteProgress(route = {}, completedGoalIds = []) {
  const completed = new Set(
    (Array.isArray(completedGoalIds) ? completedGoalIds : [])
      .map(text)
      .filter(Boolean)
  );
  const experiences = Array.isArray(route?.experiences) ? route.experiences : [];
  const milestones = experiences.map((experience) => {
    const skills = Array.isArray(experience?.skills) ? experience.skills : [];
    const completedGoals = skills.filter((skill) => completed.has(text(skill?.id)));
    return {
      experience: Number(experience?.order) || 1,
      experienceId: text(experience?.id),
      label: text(experience?.label),
      name: text(experience?.name),
      total: skills.length,
      completed: completedGoals.length,
      done: skills.length > 0 && completedGoals.length === skills.length,
    };
  });
  const currentIndex = milestones.findIndex((milestone) => !milestone.done);
  const isComplete = milestones.length > 0 && currentIndex === -1;
  const currentExperience = isComplete
    ? null
    : experiences[currentIndex >= 0 ? currentIndex : 0] || null;
  const currentSkills = Array.isArray(currentExperience?.skills)
    ? currentExperience.skills
    : [];
  const allGoals = experiences.flatMap((experience) =>
    Array.isArray(experience?.skills) ? experience.skills : []
  );
  const completedGoals = allGoals.filter((goal) => completed.has(text(goal?.id))).length;

  return {
    isComplete,
    currentExperience,
    currentExperienceId: text(currentExperience?.id),
    currentExperienceOrder: Number(currentExperience?.order) || 0,
    activeGoalIds: currentSkills
      .map((goal) => text(goal?.id))
      .filter((goalId) => goalId && !completed.has(goalId)),
    completedExperienceCount: milestones.filter((milestone) => milestone.done).length,
    totalExperiences: experiences.length,
    completedGoals,
    totalGoals: allGoals.length,
    percent: allGoals.length ? Math.round((completedGoals / allGoals.length) * 100) : 0,
    milestones: milestones.map((milestone, index) => ({
      ...milestone,
      unlocked: isComplete || index <= (currentIndex < 0 ? milestones.length - 1 : currentIndex),
    })),
  };
}

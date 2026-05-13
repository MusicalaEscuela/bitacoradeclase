import {
  getRouteTemplatesCollectionName,
  getStudentRouteProgressCollectionName,
  getStudentRoutesCollectionName,
} from "../config.js";
import {
  db,
  doc,
  getCurrentUser,
  getDoc,
  normalizeTimestamps,
  serverTimestamp,
  setDoc,
} from "../firebase.client.js";
import {
  isPlainObject,
  toArraySafe,
  toStringSafe,
  uniqueStrings,
} from "../utils/shared.js";

const STUDENT_ROUTES_COLLECTION = getStudentRoutesCollectionName();
const ROUTE_TEMPLATES_COLLECTION = getRouteTemplatesCollectionName();
const STUDENT_ROUTE_PROGRESS_COLLECTION = getStudentRouteProgressCollectionName();
const DEFAULT_PROCESS_KEY = "general";
const PROGRESS_FIELDS = [
  "completedGoalIds",
  "activeGoalIds",
  "history",
  "milestones",
  "stage",
  "experience",
  "recommendations",
];

function createApiError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

function assertAuthenticated() {
  const currentUser = getCurrentUser();

  if (!currentUser?.uid) {
    throw createApiError(
      "Debes iniciar sesión con Google para consultar o guardar la ruta del estudiante.",
      { code: "AUTH_REQUIRED" }
    );
  }

  return currentUser;
}

function normalizeHistoryEntry(entry = {}) {
  if (!isPlainObject(entry)) return null;

  const goalId = toStringSafe(entry.goalId);
  if (!goalId) return null;

  return {
    goalId,
    title: toStringSafe(entry.title),
    component: toStringSafe(entry.component),
    experience: Number(entry.experience) || 1,
    completedAt: entry.completedAt || null,
  };
}

function normalizeCustomGoal(goal = {}, index = 0) {
  if (!isPlainObject(goal)) return null;

  const title = toStringSafe(goal.title);
  if (!title) return null;

  return {
    id: toStringSafe(goal.id) || `custom-goal-${index + 1}`,
    title,
    component: toStringSafe(goal.component) || "general",
    componentLabel: toStringSafe(goal.componentLabel),
    section: toStringSafe(goal.section),
    experience: Number(goal.experience) || 1,
    order: Number(goal.order) || index + 1,
    description: toStringSafe(goal.description),
  };
}

function normalizeMilestone(milestone = {}) {
  if (!isPlainObject(milestone)) return null;

  const experience = Number(milestone.experience);
  if (!Number.isFinite(experience) || experience <= 0) return null;

  return {
    experience,
    total: Number(milestone.total) || 0,
    completed: Number(milestone.completed) || 0,
    unlocked: Boolean(milestone.unlocked),
    done: Boolean(milestone.done),
  };
}

function normalizeStudentRouteRecord(data = {}, studentId = "") {
  const normalized = normalizeTimestamps(isPlainObject(data) ? data : {});
  const safeStudentId =
    toStringSafe(normalized.studentId || normalized.studentKey) ||
    toStringSafe(studentId);

  return {
    studentId: safeStudentId,
    studentKey:
      toStringSafe(normalized.studentKey || normalized.studentId) || safeStudentId,
    processKey: toStringSafe(normalized.processKey || DEFAULT_PROCESS_KEY),
    processLabel: toStringSafe(normalized.processLabel || normalized.focusArea),
    studentName: toStringSafe(
      normalized.studentName || normalized.nombre || normalized.displayName
    ),
    routeTemplateId: toStringSafe(
      normalized.routeTemplateId ||
        normalized.id ||
        normalized.templateId ||
        normalized.instrumentKey ||
        normalized.areaKey ||
        normalized.processKey ||
        normalized.presetId
    ),
    areaKey: toStringSafe(normalized.areaKey),
    instrumentKey: toStringSafe(normalized.instrumentKey),
    presetId: toStringSafe(normalized.presetId || "musicala_base_v1"),
    routeName: toStringSafe(normalized.routeName || "Ruta base Musicala"),
    stage: toStringSafe(normalized.stage || normalized.etapa || "Experiencia 1"),
    experience: Number(normalized.experience) || 1,
    focusArea: toStringSafe(normalized.focusArea),
    completedGoalIds: uniqueStrings(normalized.completedGoalIds),
    activeGoalIds: uniqueStrings(normalized.activeGoalIds),
    milestones: toArraySafe(normalized.milestones)
      .map(normalizeMilestone)
      .filter(Boolean),
    recommendations: uniqueStrings(normalized.recommendations),
    customGoals: toArraySafe(normalized.customGoals || normalized.goals)
      .map(normalizeCustomGoal)
      .filter(Boolean),
    history: toArraySafe(normalized.history)
      .map(normalizeHistoryEntry)
      .filter(Boolean),
    createdAt: normalized.createdAt || null,
    updatedAt: normalized.updatedAt || null,
    lastUpdatedBy: isPlainObject(normalized.lastUpdatedBy)
      ? {
          uid: toStringSafe(normalized.lastUpdatedBy.uid),
          email: toStringSafe(normalized.lastUpdatedBy.email),
          name: toStringSafe(normalized.lastUpdatedBy.name),
        }
      : null,
  };
}

function splitRouteStructure(route = {}) {
  const normalized = normalizeStudentRouteRecord(route);
  return {
    id: normalized.routeTemplateId,
    routeTemplateId: normalized.routeTemplateId,
    areaKey: normalized.areaKey,
    instrumentKey: normalized.instrumentKey,
    processKey: normalized.processKey,
    processLabel: normalized.processLabel,
    presetId: normalized.presetId,
    routeName: normalized.routeName,
    focusArea: normalized.focusArea,
    customGoals: normalized.customGoals,
    goals: normalized.customGoals,
    active: route?.active !== false,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    lastUpdatedBy: normalized.lastUpdatedBy,
  };
}

function splitRouteProgress(route = {}) {
  const normalized = normalizeStudentRouteRecord(route);
  return {
    studentId: normalized.studentId,
    studentKey: normalized.studentKey,
    processKey: normalized.processKey,
    processLabel: normalized.processLabel,
    studentName: normalized.studentName,
    routeTemplateId: normalized.routeTemplateId,
    stage: normalized.stage,
    experience: normalized.experience,
    completedGoalIds: normalized.completedGoalIds,
    activeGoalIds: normalized.activeGoalIds,
    milestones: normalized.milestones,
    recommendations: normalized.recommendations,
    history: normalized.history,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    lastUpdatedBy: normalized.lastUpdatedBy,
  };
}

function mergeRouteStructureAndProgress(structure = null, progress = null) {
  if (!structure && !progress) return null;
  const route = {
    ...(structure || progress || {}),
  };

  PROGRESS_FIELDS.forEach((field) => {
    if (progress && progress[field] !== undefined && progress[field] !== null) {
      route[field] = progress[field];
    }
  });

  return route;
}

function buildStudentRouteDocId(studentId, processKey = "") {
  const safeStudentId = toStringSafe(studentId);
  const safeProcessKey = toStringSafe(processKey || DEFAULT_PROCESS_KEY);
  return `${safeStudentId}__${safeProcessKey}`;
}

function resolveRouteTemplateId(route = {}, options = {}) {
  return (
    toStringSafe(options.routeTemplateId) ||
    toStringSafe(route?.routeTemplateId) ||
    toStringSafe(route?.instrumentKey) ||
    toStringSafe(route?.areaKey) ||
    toStringSafe(route?.processKey) ||
    DEFAULT_PROCESS_KEY
  );
}

function buildStudentRouteProgressDocId(studentId, routeTemplateId = "") {
  const safeStudentId = toStringSafe(studentId);
  const safeRouteTemplateId = toStringSafe(routeTemplateId || DEFAULT_PROCESS_KEY);
  return `${safeStudentId}__${safeRouteTemplateId}`;
}

function buildPersistedRoutePayload(studentId, route = {}, options = {}) {
  const safeStudentId = toStringSafe(studentId);
  if (!safeStudentId) {
    throw createApiError("Se requiere studentId para guardar la ruta.", {
      code: "MISSING_STUDENT_ID",
    });
  }

  const student = isPlainObject(options.student) ? options.student : {};
  const currentUser = assertAuthenticated();
  const normalizedRoute = normalizeStudentRouteRecord(route, safeStudentId);
  const routeTemplateId = resolveRouteTemplateId(normalizedRoute, options);

  return {
    ...normalizedRoute,
    studentId: safeStudentId,
    routeTemplateId,
    areaKey: toStringSafe(options.areaKey || normalizedRoute.areaKey || routeTemplateId),
    instrumentKey: toStringSafe(
      options.instrumentKey || normalizedRoute.instrumentKey || routeTemplateId
    ),
    studentKey:
      toStringSafe(student.studentKey || student.studentId) || safeStudentId,
    studentName: toStringSafe(
      student.nombreCompleto ||
        student.nombre ||
        student.name ||
        normalizedRoute.studentName
    ),
    lastUpdatedBy: {
      uid: toStringSafe(currentUser.uid),
      email: toStringSafe(currentUser.email).toLowerCase(),
      name: toStringSafe(currentUser.name || currentUser.displayName),
    },
  };
}

export async function getStudentRouteRecord(studentId, options = {}) {
  assertAuthenticated();

  const safeStudentId = toStringSafe(studentId);
  if (!safeStudentId) {
    throw createApiError("Se requiere studentId para consultar la ruta.", {
      code: "MISSING_STUDENT_ID",
    });
  }

  const processKey = toStringSafe(options.processKey || DEFAULT_PROCESS_KEY);
  const routeTemplateId = toStringSafe(options.routeTemplateId || processKey || DEFAULT_PROCESS_KEY);
  const processDocId = buildStudentRouteDocId(safeStudentId, processKey);
  let templateSnapshot = await getDoc(
    doc(db, ROUTE_TEMPLATES_COLLECTION, routeTemplateId)
  );

  let legacySnapshot = null;
  if (!templateSnapshot.exists()) {
    legacySnapshot = await getDoc(doc(db, STUDENT_ROUTES_COLLECTION, processDocId));
    if (!legacySnapshot.exists()) {
      legacySnapshot = await getDoc(doc(db, STUDENT_ROUTES_COLLECTION, safeStudentId));
    }
  }

  const structure = templateSnapshot.exists()
    ? splitRouteStructure(
        normalizeStudentRouteRecord(
          { routeTemplateId, ...templateSnapshot.data() },
          safeStudentId
        )
      )
    : legacySnapshot?.exists()
    ? splitRouteStructure(normalizeStudentRouteRecord(legacySnapshot.data(), safeStudentId))
    : null;
  const legacyProgress = legacySnapshot?.exists()
    ? splitRouteProgress(normalizeStudentRouteRecord(legacySnapshot.data(), safeStudentId))
    : null;

  let progressSnapshot = await getDoc(
    doc(
      db,
      STUDENT_ROUTE_PROGRESS_COLLECTION,
      buildStudentRouteProgressDocId(safeStudentId, routeTemplateId)
    )
  );

  if (!progressSnapshot.exists()) {
    progressSnapshot = await getDoc(
      doc(db, STUDENT_ROUTE_PROGRESS_COLLECTION, processDocId)
    );
  }

  const progress = progressSnapshot.exists()
    ? splitRouteProgress(normalizeStudentRouteRecord(progressSnapshot.data(), safeStudentId))
    : legacyProgress;

  return mergeRouteStructureAndProgress(structure, progress);
}

async function saveRouteDocument(collectionName, studentId, route = {}, options = {}, picker) {
  const safeStudentId = toStringSafe(studentId);
  const payload = buildPersistedRoutePayload(safeStudentId, route, options);
  const persistedPayload = picker(payload);
  const routeTemplateId = resolveRouteTemplateId(persistedPayload, options);
  const processKey =
    toStringSafe(options.processKey || persistedPayload.processKey) ||
    routeTemplateId ||
    DEFAULT_PROCESS_KEY;
  const ref =
    collectionName === ROUTE_TEMPLATES_COLLECTION
      ? doc(db, collectionName, routeTemplateId)
      : doc(
          db,
          collectionName,
          buildStudentRouteProgressDocId(safeStudentId, routeTemplateId)
        );

  await setDoc(
    ref,
    {
      ...persistedPayload,
      routeTemplateId,
      processKey,
      updatedAt: serverTimestamp(),
      createdAt: persistedPayload.createdAt || serverTimestamp(),
    },
    { merge: true }
  );

  return (
    (await getStudentRouteRecord(safeStudentId, {
      processKey,
      routeTemplateId,
    })) || payload
  );
}

export async function saveStudentRouteRecord(studentId, route = {}, options = {}) {
  return saveRouteDocument(
    ROUTE_TEMPLATES_COLLECTION,
    studentId,
    route,
    options,
    splitRouteStructure
  );
}

export async function saveStudentRouteProgressRecord(studentId, route = {}, options = {}) {
  return saveRouteDocument(
    STUDENT_ROUTE_PROGRESS_COLLECTION,
    studentId,
    route,
    options,
    splitRouteProgress
  );
}

export default {
  getStudentRouteRecord,
  saveStudentRouteRecord,
  saveStudentRouteProgressRecord,
};

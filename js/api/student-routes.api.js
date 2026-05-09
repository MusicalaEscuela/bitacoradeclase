import {
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
    customGoals: toArraySafe(normalized.customGoals)
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
    studentId: normalized.studentId,
    studentKey: normalized.studentKey,
    processKey: normalized.processKey,
    processLabel: normalized.processLabel,
    studentName: normalized.studentName,
    presetId: normalized.presetId,
    routeName: normalized.routeName,
    focusArea: normalized.focusArea,
    customGoals: normalized.customGoals,
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

  return {
    ...normalizedRoute,
    studentId: safeStudentId,
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
  const processDocId = buildStudentRouteDocId(safeStudentId, processKey);
  let snapshot = await getDoc(doc(db, STUDENT_ROUTES_COLLECTION, processDocId));

  if (!snapshot.exists()) {
    snapshot = await getDoc(doc(db, STUDENT_ROUTES_COLLECTION, safeStudentId));
  }

  const structure = snapshot.exists()
    ? splitRouteStructure(normalizeStudentRouteRecord(snapshot.data(), safeStudentId))
    : null;
  const legacyProgress = snapshot.exists()
    ? splitRouteProgress(normalizeStudentRouteRecord(snapshot.data(), safeStudentId))
    : null;

  let progressSnapshot = await getDoc(
    doc(db, STUDENT_ROUTE_PROGRESS_COLLECTION, processDocId)
  );

  if (!progressSnapshot.exists()) {
    progressSnapshot = await getDoc(
      doc(db, STUDENT_ROUTE_PROGRESS_COLLECTION, safeStudentId)
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
  const processKey =
    toStringSafe(options.processKey || persistedPayload.processKey) || DEFAULT_PROCESS_KEY;
  const ref = doc(
    db,
    collectionName,
    buildStudentRouteDocId(safeStudentId, processKey)
  );

  await setDoc(
    ref,
    {
      ...persistedPayload,
      updatedAt: serverTimestamp(),
      createdAt: persistedPayload.createdAt || serverTimestamp(),
    },
    { merge: true }
  );

  return (await getStudentRouteRecord(safeStudentId, { processKey })) || payload;
}

export async function saveStudentRouteRecord(studentId, route = {}, options = {}) {
  return saveRouteDocument(
    STUDENT_ROUTES_COLLECTION,
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

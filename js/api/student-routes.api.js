import { getStudentRoutesCollectionName } from "../config.js";
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
const DEFAULT_PROCESS_KEY = "general";

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

  if (!snapshot.exists()) {
    return null;
  }

  return normalizeStudentRouteRecord(snapshot.data(), safeStudentId);
}

export async function saveStudentRouteRecord(studentId, route = {}, options = {}) {
  const safeStudentId = toStringSafe(studentId);
  const payload = buildPersistedRoutePayload(safeStudentId, route, options);
  const processKey =
    toStringSafe(options.processKey || payload.processKey) || DEFAULT_PROCESS_KEY;
  const ref = doc(
    db,
    STUDENT_ROUTES_COLLECTION,
    buildStudentRouteDocId(safeStudentId, processKey)
  );

  await setDoc(
    ref,
    {
      ...payload,
      updatedAt: serverTimestamp(),
      createdAt: payload.createdAt || serverTimestamp(),
    },
    { merge: true }
  );

  return (
    (await getStudentRouteRecord(safeStudentId, { processKey })) || payload
  );
}

export default {
  getStudentRouteRecord,
  saveStudentRouteRecord,
};

import {
  collection,
  db,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "../firebase.client.js";
import { toStringSafe } from "../utils/shared.js";

const USERS_COLLECTION = "users";
const STUDENT_ROLE_ALIASES = new Set(["student", "estudiante"]);

function normalizeAccessEmail(email) {
  return toStringSafe(email).replace(/\s+/g, "").toLowerCase();
}

export function buildUserAccessDocId(value) {
  return normalizeAccessEmail(value);
}

function isPermissionDeniedError(error) {
  const code = toStringSafe(error?.code).toLowerCase();
  const message = toStringSafe(error?.message).toLowerCase();

  return (
    code.includes("permission-denied") ||
    message.includes("missing or insufficient permissions")
  );
}

function normalizeUserAccess(docSnap) {
  const data = docSnap?.data?.() || {};
  const fallbackEmail =
    docSnap?.id && String(docSnap.id).includes("@") ? docSnap.id : "";

  return {
    id: docSnap?.id || "",
    uid: toStringSafe(data.uid),
    email: normalizeAccessEmail(data.email || fallbackEmail),
    role: toStringSafe(data.role || data.rol).toLowerCase(),
    studentId: toStringSafe(data.studentId || data.studentKey || data.estudianteId),
    studentKey: toStringSafe(data.studentKey || data.studentId || data.estudianteId),
    studentIds: Array.isArray(data.studentIds)
      ? data.studentIds.map(toStringSafe).filter(Boolean)
      : Array.isArray(data.students)
      ? data.students.map(toStringSafe).filter(Boolean)
      : [],
    displayName: toStringSafe(data.displayName || data.name || data.nombre),
    studentStatus: toStringSafe(data.studentStatus || data.estado || data.status),
    active: data.active !== false,
    source: toStringSafe(data.source),
    syncOrigin: toStringSafe(data.syncOrigin),
    statusSource: toStringSafe(data.statusSource),
    teacherAccessManaged: data.teacherAccessManaged === true,
  };
}

async function getUserAccessByDocId(docId) {
  const safeDocId = toStringSafe(docId);
  if (!safeDocId) return null;

  const snapshot = await getDoc(doc(db, USERS_COLLECTION, safeDocId));
  if (!snapshot.exists()) return null;

  return normalizeUserAccess(snapshot);
}

async function findOneByField(field, value) {
  const safeValue =
    field === "email"
      ? normalizeAccessEmail(value)
      : toStringSafe(value);

  if (!safeValue) return null;

  const snapshot = await getDocs(
    query(collection(db, USERS_COLLECTION), where(field, "==", safeValue), limit(1))
  );

  if (!snapshot?.docs?.length) return null;
  return normalizeUserAccess(snapshot.docs[0]);
}

function scoreUserAccessProfile(profile = {}) {
  let score = 0;

  if (profile.email && profile.id === buildUserAccessDocId(profile.email)) {
    score += 4;
  }

  if (profile.active) score += 2;
  if (profile.role) score += 1;
  if (profile.studentId) score += 1;

  return score;
}

function dedupeUserAccessProfiles(users = []) {
  const bestByKey = new Map();

  users.forEach((user) => {
    if (!user) return;

    const key = user.email || user.id;
    if (!key) return;

    const current = bestByKey.get(key);
    if (!current || scoreUserAccessProfile(user) >= scoreUserAccessProfile(current)) {
      bestByKey.set(key, user);
    }
  });

  return [...bestByKey.values()];
}

async function listAllUserAccessProfiles() {
  const snapshot = await getDocs(collection(db, USERS_COLLECTION));
  return dedupeUserAccessProfiles(snapshot.docs.map(normalizeUserAccess));
}

export async function getUserAccessProfile(authUser = null) {
  const uid = toStringSafe(authUser?.uid);
  const email = normalizeAccessEmail(authUser?.email);

  try {
    if (email) {
      const byDocId = await getUserAccessByDocId(buildUserAccessDocId(email));
      if (byDocId) return byDocId;
    }

    if (uid) {
      const byUid = await findOneByField("uid", uid);
      if (byUid) return byUid;
    }

    if (email) {
      const byEmail = await findOneByField("email", email);
      if (byEmail) return byEmail;
    }
  } catch (error) {
    if (isPermissionDeniedError(error)) {
      return null;
    }

    throw error;
  }

  return null;
}

export async function listStudentAccessUsers() {
  const users = await listAllUserAccessProfiles();

  return users
    .filter((user) => STUDENT_ROLE_ALIASES.has(user.role))
    .sort((a, b) =>
      a.displayName.localeCompare(b.displayName, "es", { sensitivity: "base" })
    );
}

/**
 * Mantiene sincronizado el acceso docente con el catálogo administrado en
 * app_config/catalogos. Solo se invoca desde una sesión administrativa.
 */
export async function saveTeacherAccessProfile(teacher = {}, actor = null) {
  const email = normalizeAccessEmail(teacher.email);
  if (!email) return { skipped: true, reason: "missing-email" };

  const ref = doc(db, USERS_COLLECTION, buildUserAccessDocId(email));
  const existingSnapshot = await getDoc(ref);
  const existing = existingSnapshot.exists() ? normalizeUserAccess(existingSnapshot) : null;

  // Nunca convertir un perfil administrativo existente en docente por efecto
  // de sincronizar el catálogo.
  if (existing && normalizeAccessEmail(existing.role) === "admin") {
    return { email, skipped: true, reason: "admin-profile" };
  }

  // Los perfiles históricos que ya conceden acceso no se reescriben ni se
  // migran automáticamente; solo los perfiles creados por este administrador
  // quedan bajo el nuevo contrato de sincronización.
  if (existing && existing.teacherAccessManaged !== true) {
    return { email, skipped: true, reason: "legacy-profile" };
  }

  const now = serverTimestamp();
  const existingRole = normalizeAccessEmail(existing?.role);
  const payload = {
    email,
    role: ["teacher", "docente", "profesor", "profesora"].includes(existingRole)
      ? existingRole
      : "docente",
    active: teacher.activo !== false,
    teacherAccessManaged: true,
    displayName: toStringSafe(teacher.nombre || teacher.alias || email),
    linkedBy: normalizeAccessEmail(actor?.email),
    updatedAt: now,
  };

  if (!existingSnapshot.exists()) {
    payload.linkedAt = now;
  }

  await setDoc(ref, payload, { merge: true });
  return { email, created: !existingSnapshot.exists(), updated: true };
}

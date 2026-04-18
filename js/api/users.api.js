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
  writeBatch,
} from "../firebase.client.js";
import {
  getStudentsFromSheet,
  isStudentAllowedToLogIn,
} from "./students.api.js";
import { toStringSafe } from "../utils/shared.js";

const USERS_COLLECTION = "users";
const STUDENT_ROLE = "student";
const TEACHER_ROLE = "teacher";
const FIRESTORE_BATCH_LIMIT = 400;

function normalizeAccessEmail(email) {
  return toStringSafe(email).toLowerCase();
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
    displayName: toStringSafe(data.displayName || data.name || data.nombre),
    studentStatus: toStringSafe(data.studentStatus || data.estado || data.status),
    active: data.active !== false,
    source: toStringSafe(data.source),
    syncOrigin: toStringSafe(data.syncOrigin),
  };
}

function normalizeStudentAccessSource(student = {}) {
  const email = normalizeAccessEmail(
    student.email ||
      student.correo ||
      student.correoElectronico ||
      student.mail
  );
  const studentKey = toStringSafe(
    student.studentKey || student.id || student.studentId || student.sourceRow
  );
  const displayName = toStringSafe(
    student.nombre || student.name || student.nombreCompleto
  );

  return {
    email,
    studentId: studentKey,
    studentKey,
    displayName,
    studentStatus: toStringSafe(
      student.estado || student.status || student.estadoActual
    ),
    active: true,
    raw: student,
  };
}

function normalizeTeacherAccessSource(teacher = {}, index = 0) {
  const email = normalizeAccessEmail(
    teacher.email ||
      teacher.correo ||
      teacher.correoElectronico ||
      teacher.mail
  );
  const displayName = toStringSafe(
    teacher.alias || teacher.nombre || teacher.name || `Docente ${index + 1}`
  );

  return {
    email,
    displayName,
    active: teacher.activo !== false,
    raw: teacher,
  };
}

function isStudentRecordActive(student = {}) {
  return isStudentAllowedToLogIn(student);
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

function createEmptySyncReport() {
  return {
    totalStudentsRead: 0,
    validStudents: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skippedMissingEmail: 0,
    skippedDuplicateEmail: 0,
    conflicts: 0,
    synced: 0,
    samples: [],
  };
}

function chunkArray(items = [], size = FIRESTORE_BATCH_LIMIT) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function hasAccessChanges(existingUser, nextPayload) {
  if (!existingUser) return true;

  return (
    existingUser.email !== nextPayload.email ||
    existingUser.role !== nextPayload.role ||
    existingUser.studentId !== nextPayload.studentId ||
    existingUser.studentKey !== nextPayload.studentKey ||
    existingUser.displayName !== nextPayload.displayName ||
    existingUser.studentStatus !== nextPayload.studentStatus ||
    existingUser.active !== nextPayload.active ||
    existingUser.source !== nextPayload.source ||
    existingUser.syncOrigin !== nextPayload.syncOrigin
  );
}

async function commitAccessOperations(operations = []) {
  if (!operations.length) return;

  const chunks = chunkArray(operations, FIRESTORE_BATCH_LIMIT);

  for (const chunk of chunks) {
    const batch = writeBatch(db);

    chunk.forEach((operation) => {
      const ref = doc(db, USERS_COLLECTION, operation.docId);
      const payload = {
        ...operation.payload,
        updatedAt: serverTimestamp(),
      };

      if (operation.isCreate) {
        payload.createdAt = serverTimestamp();
      }

      batch.set(ref, payload, { merge: true });
    });

    await batch.commit();
  }
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
    .filter((user) => user.role === STUDENT_ROLE)
    .sort((a, b) =>
      a.displayName.localeCompare(b.displayName, "es", { sensitivity: "base" })
    );
}

export async function syncStudentAccessUsersFromSheet(options = {}) {
  const report = createEmptySyncReport();
  const students = await getStudentsFromSheet({
    includeInactive: true,
    estado: "todos",
    timeoutMs: options.timeoutMs,
  });

  report.totalStudentsRead = Array.isArray(students) ? students.length : 0;

  const existingUsers = await listAllUserAccessProfiles();
  const existingByEmail = new Map();
  const existingByStudentId = new Map();

  existingUsers.forEach((user) => {
    if (user.email) existingByEmail.set(user.email, user);
    if (user.studentId) existingByStudentId.set(user.studentId, user);
  });

  const seenEmails = new Set();
  const operations = [];

  students.forEach((student) => {
    const source = normalizeStudentAccessSource(student);

    if (!source.email) {
      report.skippedMissingEmail += 1;
      return;
    }

    if (seenEmails.has(source.email)) {
      report.skippedDuplicateEmail += 1;
      return;
    }

    seenEmails.add(source.email);
    report.validStudents += 1;

    const existingUser =
      existingByStudentId.get(source.studentId) ||
      existingByEmail.get(source.email) ||
      null;

    if (existingUser && existingUser.role && existingUser.role !== STUDENT_ROLE) {
      report.conflicts += 1;
      return;
    }

    const payload = {
      email: source.email,
      role: STUDENT_ROLE,
      studentId: source.studentId,
      studentKey: source.studentKey,
      displayName: source.displayName,
      studentStatus: source.studentStatus,
      active: isStudentRecordActive(student),
      source: "students_sheet_sync",
      sourceRow: student?.sourceRow || null,
      syncOrigin: "settings_view",
    };

    if (!hasAccessChanges(existingUser, payload)) {
      report.unchanged += 1;
      return;
    }

    const docId = buildUserAccessDocId(source.email);
    operations.push({
      docId,
      payload,
      isCreate: !existingUser || existingUser.id !== docId,
    });

    if (existingUser) {
      report.updated += 1;
    } else {
      report.created += 1;
    }

    if (report.samples.length < 8) {
      report.samples.push({
        email: source.email,
        displayName: source.displayName,
        action: existingUser ? "updated" : "created",
      });
    }
  });

  await commitAccessOperations(operations);

  report.synced = report.created + report.updated;
  return report;
}

export async function syncTeacherAccessUsers(teachers = []) {
  const existingUsers = await listAllUserAccessProfiles();
  const existingTeachersByEmail = new Map();

  existingUsers
    .filter((user) => user.role === TEACHER_ROLE)
    .forEach((user) => {
      if (user.email) {
        existingTeachersByEmail.set(user.email, user);
      }
    });

  const seenEmails = new Set();
  const operations = [];

  teachers.forEach((teacher, index) => {
    const source = normalizeTeacherAccessSource(teacher, index);
    if (!source.email) return;

    seenEmails.add(source.email);

    const existingUser = existingTeachersByEmail.get(source.email) || null;
    const payload = {
      email: source.email,
      role: TEACHER_ROLE,
      studentId: "",
      studentKey: "",
      displayName: source.displayName,
      studentStatus: "",
      active: source.active,
      source: "catalogs_teachers_sync",
      syncOrigin: "catalogs_save",
    };

    if (!hasAccessChanges(existingUser, payload)) {
      return;
    }

    const docId = buildUserAccessDocId(source.email);
    operations.push({
      docId,
      payload,
      isCreate: !existingUser || existingUser.id !== docId,
    });
  });

  existingTeachersByEmail.forEach((user, email) => {
    if (seenEmails.has(email)) return;

    const payload = {
      email,
      role: TEACHER_ROLE,
      studentId: "",
      studentKey: "",
      displayName: user.displayName,
      studentStatus: "",
      active: false,
      source: "catalogs_teachers_sync",
      syncOrigin: "catalogs_save",
    };

    if (!hasAccessChanges(user, payload)) {
      return;
    }

    operations.push({
      docId: buildUserAccessDocId(email),
      payload,
      isCreate: user.id !== buildUserAccessDocId(email),
    });
  });

  await commitAccessOperations(operations);
}

export async function upsertUserAccessProfile(docId, payload = {}) {
  const safeDocId =
    buildUserAccessDocId(docId) || toStringSafe(docId);

  if (!safeDocId) {
    throw new Error("Se requiere docId para guardar el perfil de acceso.");
  }

  await setDoc(
    doc(db, USERS_COLLECTION, safeDocId),
    {
      ...payload,
      email: normalizeAccessEmail(payload.email || safeDocId),
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    },
    { merge: true }
  );

  return safeDocId;
}

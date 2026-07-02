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
const STUDENT_ROLE_ALIASES = new Set(["student", "estudiante"]);
const TEACHER_ROLE = "teacher";
const FIRESTORE_BATCH_LIMIT = 400;

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
  const studentIds = normalizeStudentIdList([
    student.studentKey,
    student.id,
    student.studentId,
    student.estudianteId,
    student.documento,
    student.identificacion,
    student.numeroDocumento,
    student.sourceRow,
    ...(Array.isArray(student.studentIds) ? student.studentIds : []),
    ...(Array.isArray(student.duplicateRecords)
      ? student.duplicateRecords.flatMap((record) => [
          record?.studentKey,
          record?.id,
          record?.studentId,
          record?.estudianteId,
          record?.documento,
        ])
      : []),
  ]);

  return {
    email,
    studentId: studentKey,
    studentKey,
    studentIds,
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

function normalizeStudentIdList(values = []) {
  return [...new Set(values.map(toStringSafe).filter(Boolean))].sort();
}

function hasAccessChanges(existingUser, nextPayload) {
  if (!existingUser) return true;

  const existingStudentIds = normalizeStudentIdList(existingUser.studentIds || []);
  const nextStudentIds = normalizeStudentIdList(nextPayload.studentIds || []);
  if (JSON.stringify(existingStudentIds) !== JSON.stringify(nextStudentIds)) {
    return true;
  }

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
    .filter((user) => STUDENT_ROLE_ALIASES.has(user.role))
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

  existingUsers.forEach((user) => {
    if (!user.email) return;

    const current = existingByEmail.get(user.email);
    // Preferir siempre el doc canonico users/{correo} sobre docs legados.
    if (!current || user.id === buildUserAccessDocId(user.email)) {
      existingByEmail.set(user.email, user);
    }
  });

  // Un acudiente puede tener varios hijos con el mismo correo: agrupar filas.
  const groupsByEmail = new Map();

  students.forEach((student) => {
    const source = normalizeStudentAccessSource(student);

    if (!source.email) {
      report.skippedMissingEmail += 1;
      return;
    }

    const group = groupsByEmail.get(source.email);
    if (group) {
      report.skippedDuplicateEmail += 1;
      group.push({ source, student });
      return;
    }

    groupsByEmail.set(source.email, [{ source, student }]);
  });

  const operations = [];

  groupsByEmail.forEach((group, email) => {
    report.validStudents += 1;

    const docId = buildUserAccessDocId(email);
    const existingUser = existingByEmail.get(email) || null;
    const canonicalUser =
      existingUser && existingUser.id === docId ? existingUser : null;

    if (
      existingUser &&
      existingUser.role &&
      !STUDENT_ROLE_ALIASES.has(existingUser.role)
    ) {
      report.conflicts += 1;
      return;
    }

    const primaryEntry =
      group.find((entry) => isStudentRecordActive(entry.student)) || group[0];
    const anyActive = group.some((entry) => isStudentRecordActive(entry.student));
    const studentIds = normalizeStudentIdList([
      ...(existingUser?.studentIds || []),
      ...(existingUser?.studentId ? [existingUser.studentId] : []),
      ...group.flatMap((entry) => entry.source.studentIds),
    ]);

    const payload = {
      email,
      role: STUDENT_ROLE,
      studentId: primaryEntry.source.studentId,
      studentKey: primaryEntry.source.studentKey,
      studentIds,
      displayName: primaryEntry.source.displayName,
      studentStatus: primaryEntry.source.studentStatus,
      active: anyActive,
      source: "students_sheet_sync",
      sourceRow: primaryEntry.student?.sourceRow || null,
      syncOrigin: "settings_view",
    };

    if (canonicalUser && !hasAccessChanges(canonicalUser, payload)) {
      report.unchanged += 1;
      return;
    }

    operations.push({
      docId,
      payload,
      isCreate: !canonicalUser,
    });

    if (canonicalUser) {
      report.updated += 1;
    } else {
      report.created += 1;
    }

    if (report.samples.length < 8) {
      report.samples.push({
        email,
        displayName: payload.displayName,
        action: canonicalUser ? "updated" : "created",
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

    const docId = buildUserAccessDocId(source.email);
    const existingUser = existingTeachersByEmail.get(source.email) || null;
    const canonicalUser =
      existingUser && existingUser.id === docId ? existingUser : null;
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

    if (canonicalUser && !hasAccessChanges(canonicalUser, payload)) {
      return;
    }

    operations.push({
      docId,
      payload,
      isCreate: !canonicalUser,
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

    const docId = buildUserAccessDocId(email);
    const isCanonical = user.id === docId;

    if (isCanonical && !hasAccessChanges(user, payload)) {
      return;
    }

    operations.push({
      docId,
      payload,
      isCreate: !isCanonical,
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

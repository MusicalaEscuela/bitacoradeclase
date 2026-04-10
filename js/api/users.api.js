import {
  collection,
  db,
  doc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from "../firebase.client.js";
import { getStudents, isStudentAllowedToLogIn } from "./students.api.js";
import { toStringSafe } from "../utils/shared.js";

const USERS_COLLECTION = "users";
const STUDENT_ROLE = "student";
const FIRESTORE_BATCH_LIMIT = 400;

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

  return {
    id: docSnap?.id || "",
    uid: toStringSafe(data.uid),
    email: toStringSafe(data.email).toLowerCase(),
    role: toStringSafe(data.role || data.rol).toLowerCase(),
    studentId: toStringSafe(data.studentId || data.studentKey || data.estudianteId),
    studentKey: toStringSafe(data.studentKey || data.studentId || data.estudianteId),
    displayName: toStringSafe(data.displayName || data.name || data.nombre),
    studentStatus: toStringSafe(data.studentStatus || data.estado || data.status),
    active: data.active === true,
  };
}

function normalizeStudentAccessSource(student = {}) {
  const email = toStringSafe(
    student.email ||
      student.correo ||
      student.correoElectronico ||
      student.mail
  ).toLowerCase();
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
    studentStatus: toStringSafe(student.estado || student.status || student.estadoActual),
    active: true,
    raw: student,
  };
}

function isStudentRecordActive(student = {}) {
  return isStudentAllowedToLogIn(student);
}

function buildStudentUserDocId(studentSource) {
  const base =
    toStringSafe(studentSource.studentKey) || toStringSafe(studentSource.email);

  return `student_${String(base)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}`;
}

async function findOneByField(field, value) {
  const safeValue = toStringSafe(value);
  if (!safeValue) return null;

  const snapshot = await getDocs(
    query(collection(db, USERS_COLLECTION), where(field, "==", safeValue), limit(1))
  );

  if (!snapshot?.docs?.length) return null;
  return normalizeUserAccess(snapshot.docs[0]);
}

async function listAllUserAccessProfiles() {
  const snapshot = await getDocs(collection(db, USERS_COLLECTION));
  return snapshot.docs.map(normalizeUserAccess);
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

function hasStudentAccessChanges(existingUser, nextPayload) {
  if (!existingUser) return true;

  return (
    existingUser.email !== nextPayload.email ||
    existingUser.role !== nextPayload.role ||
    existingUser.studentId !== nextPayload.studentId ||
    existingUser.studentKey !== nextPayload.studentKey ||
    existingUser.displayName !== nextPayload.displayName ||
    existingUser.studentStatus !== nextPayload.studentStatus ||
    existingUser.active !== nextPayload.active
  );
}

async function commitStudentAccessOperations(operations = []) {
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

      batch.set(
        ref,
        payload,
        { merge: true }
      );
    });

    await batch.commit();
  }
}

export async function getUserAccessProfile(authUser = null) {
  const uid = toStringSafe(authUser?.uid);
  const email = toStringSafe(authUser?.email).toLowerCase();

  try {
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
  const students = await getStudents({
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
      existingByStudentId.get(source.studentId) || existingByEmail.get(source.email) || null;

    if (
      existingUser &&
      existingUser.role &&
      existingUser.role !== STUDENT_ROLE
    ) {
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

    if (!hasStudentAccessChanges(existingUser, payload)) {
      report.unchanged += 1;
      return;
    }

    const docId = existingUser?.id || buildStudentUserDocId(source);
    operations.push({
      docId,
      payload,
      isCreate: !existingUser,
      createdAt: existingUser?.createdAt || undefined,
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

  await commitStudentAccessOperations(operations);

  report.synced = report.created + report.updated;
  return report;
}

export async function upsertUserAccessProfile(docId, payload = {}) {
  const safeDocId = toStringSafe(docId);
  if (!safeDocId) {
    throw new Error("Se requiere docId para guardar el perfil de acceso.");
  }

  await batchlessSetUserAccessProfile_(safeDocId, payload);
  return safeDocId;
}

async function batchlessSetUserAccessProfile_(docId, payload = {}) {
  await setDoc(
    doc(db, USERS_COLLECTION, docId),
    {
      ...payload,
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    },
    { merge: true }
  );
}

import { CONFIG, getApiUrl, getStudentsCollectionName } from "../config.js";
import {
  collection,
  db,
  doc,
  getDoc,
  getDocs,
  limit,
  normalizeTimestamps,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from "../firebase.client.js";
import {
  isPlainObject,
  normalizeText,
  toStringSafe,
} from "../utils/shared.js";

const DEFAULT_TIMEOUT =
  Number.isFinite(CONFIG?.api?.timeoutMs) && CONFIG.api.timeoutMs > 0
    ? CONFIG.api.timeoutMs
    : 20000;

const STUDENTS_COLLECTION = getStudentsCollectionName();
const FIRESTORE_BATCH_LIMIT = 400;

function createApiError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

function withTimeout(ms = DEFAULT_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), ms);

  return {
    signal: controller.signal,
    clear: () => window.clearTimeout(timeoutId),
  };
}

function normalizeScalar(value) {
  return toStringSafe(value);
}

function resolveStudentStatusValue(studentOrStatus) {
  if (isPlainObject(studentOrStatus)) {
    return (
      studentOrStatus.estado ||
      studentOrStatus.status ||
      studentOrStatus.estadoActual ||
      studentOrStatus.studentStatus ||
      ""
    );
  }

  return studentOrStatus;
}

export function normalizeStudentStatus(studentOrStatus) {
  return normalizeText(resolveStudentStatusValue(studentOrStatus));
}

export function isStudentAllowedToLogIn(studentOrStatus) {
  const safeStatus = normalizeStudentStatus(studentOrStatus);

  if (!safeStatus) return false;

  return (
    safeStatus === "activo" ||
    safeStatus.startsWith("activo no registro") ||
    safeStatus.startsWith("activo en pausa") ||
    safeStatus.startsWith("inactivo en pausa")
  );
}

function buildUrl(baseUrl, queryParams = {}) {
  if (!baseUrl) {
    throw createApiError("La URL base del endpoint no es valida.", {
      code: "INVALID_URL",
      baseUrl,
    });
  }

  const url = new URL(baseUrl);

  Object.entries(queryParams).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    url.searchParams.set(key, String(value));
  });

  return url.toString();
}

async function parseJsonResponse(response) {
  const rawText = await response.text();

  if (!rawText || !rawText.trim()) {
    throw createApiError("La respuesta del servidor llego vacia.", {
      code: "EMPTY_RESPONSE",
      status: response.status,
    });
  }

  try {
    return JSON.parse(rawText);
  } catch (error) {
    throw createApiError("La respuesta del servidor no es JSON valido.", {
      code: "INVALID_JSON",
      status: response.status,
      responseText: rawText,
      cause: error,
    });
  }
}

async function requestJson(url, options = {}) {
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT;

  const { signal, clear } = withTimeout(timeoutMs);

  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        Accept: "application/json",
        ...(options.headers || {}),
      },
      body: options.body,
      signal,
      redirect: "follow",
      cache: "no-store",
    });

    const payload = await parseJsonResponse(response);

    if (!response.ok || payload?.ok === false || payload?.success === false) {
      throw createApiError(
        payload?.message ||
          payload?.error ||
          `Error HTTP ${response.status} al consultar el servidor.`,
        {
          code: "HTTP_ERROR",
          status: response.status,
          payload,
          url,
        }
      );
    }

    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw createApiError("La solicitud tardo demasiado y fue cancelada.", {
        code: "REQUEST_TIMEOUT",
        url,
      });
    }

    if (error instanceof Error) {
      throw error;
    }

    throw createApiError(
      "Ocurrio un error inesperado al consultar el servidor.",
      {
        code: "UNKNOWN_REQUEST_ERROR",
        cause: error,
        url,
      }
    );
  } finally {
    clear();
  }
}

function resolveStudentsEndpoint() {
  const url = getApiUrl("students");

  if (!url) {
    throw createApiError(
      'No se pudo resolver el endpoint "students" desde config.js.',
      {
        code: "MISSING_STUDENTS_ENDPOINT",
      }
    );
  }

  return url;
}

function resolveStudentProfileEndpoint() {
  const url = getApiUrl("studentProfile");

  if (!url) {
    throw createApiError(
      'No se pudo resolver el endpoint "studentProfile" desde config.js.',
      {
        code: "MISSING_STUDENT_PROFILE_ENDPOINT",
      }
    );
  }

  return url;
}

function extractStudentsCollection(payload) {
  if (Array.isArray(payload)) return payload;
  if (!isPlainObject(payload)) return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.students)) return payload.students;
  if (Array.isArray(payload.results)) return payload.results;
  if (isPlainObject(payload.data) && Array.isArray(payload.data.students)) {
    return payload.data.students;
  }
  return [];
}

function extractSingleStudent(payload) {
  if (Array.isArray(payload)) return payload.length ? payload[0] : null;
  if (!isPlainObject(payload)) return null;
  if (isPlainObject(payload.data)) return payload.data;
  if (isPlainObject(payload.student)) return payload.student;
  if (isPlainObject(payload.profile)) return payload.profile;
  if (isPlainObject(payload.result)) return payload.result;

  if (
    "studentKey" in payload ||
    "id" in payload ||
    "studentId" in payload ||
    "nombre" in payload ||
    "name" in payload
  ) {
    return payload;
  }

  return null;
}

function normalizeStudentIdentifier(studentRef) {
  if (studentRef === undefined || studentRef === null) return "";

  if (typeof studentRef === "string" || typeof studentRef === "number") {
    return String(studentRef).trim();
  }

  if (isPlainObject(studentRef)) {
    return normalizeScalar(
      studentRef.studentKey ||
        studentRef.id ||
        studentRef.studentId ||
        studentRef.ID ||
        studentRef.documento ||
        studentRef.identificacion ||
        studentRef.cc ||
        studentRef.sourceRow
    );
  }

  return "";
}

function normalizeStudentQueryOptions(options = {}) {
  const queryValue = normalizeText(
    options.query ?? options.q ?? options.search ?? ""
  );
  const includeInactive =
    typeof options.includeInactive === "boolean"
      ? options.includeInactive
      : true;
  const statusValue = normalizeText(
    options.estado || options.status || (includeInactive ? "todos" : "")
  );
  const areaValue = normalizeText(options.arte || options.area);

  return {
    q: queryValue,
    estado: statusValue,
    arte: areaValue,
    includeInactive,
  };
}

function normalizeStudentRecord(student = {}) {
  const normalized = normalizeTimestamps(isPlainObject(student) ? student : {});
  const rawStudentKey = normalizeScalar(
    normalized.studentKey ||
      normalized.id ||
      normalized.studentId ||
      normalized.documento ||
      normalized.sourceRow
  );

  if (!rawStudentKey) return null;

  const email = normalizeScalar(
    normalized.email ||
      normalized.correo ||
      normalized.correoElectronico ||
      normalized.mail
  ).toLowerCase();

  const processes = Array.isArray(normalized.processes)
    ? normalized.processes
        .map((process, index) => normalizeProcessRecord(process, rawStudentKey, index))
        .filter(Boolean)
    : [];

  const firstProcess = processes[0] || null;

  return {
    ...normalized,
    id: rawStudentKey,
    studentId: rawStudentKey,
    studentKey: rawStudentKey,
    nombre: normalizeScalar(normalized.nombre || normalized.name),
    email,
    correo: email || normalizeScalar(normalized.correo),
    correoElectronico:
      email || normalizeScalar(normalized.correoElectronico),
    edad: normalized.edad ?? normalized.age ?? "",
    estado: normalizeScalar(normalized.estado || normalized.status),
    interesesMusicales: normalizeScalar(
      normalized.interesesMusicales || normalized.intereses
    ),
    area:
      normalizeScalar(normalized.area) ||
      normalizeScalar(firstProcess?.arte),
    programa:
      normalizeScalar(normalized.programa) ||
      normalizeScalar(firstProcess?.label),
    instrumento:
      normalizeScalar(normalized.instrumento) ||
      normalizeScalar(firstProcess?.detalle),
    modalidad: normalizeScalar(normalized.modalidad),
    docente: normalizeScalar(normalized.docente || normalized.teacher),
    acudiente: normalizeScalar(normalized.acudiente || normalized.responsable),
    sede: normalizeScalar(normalized.sede),
    source: normalizeScalar(normalized.source || "firebase_students"),
    syncOrigin: normalizeScalar(normalized.syncOrigin),
    processes,
  };
}

function normalizeProcessRecord(process = {}, studentKey = "", index = 0) {
  if (!isPlainObject(process)) return null;

  const arte = normalizeScalar(process.arte || process.area);
  const detalle = normalizeScalar(process.detalle || process.instrumento);
  const label =
    normalizeScalar(process.label) ||
    [arte, detalle].filter(Boolean).join(" - ");

  if (!arte && !detalle && !label) return null;

  return {
    processKey:
      normalizeScalar(process.processKey) || `${studentKey}_process_${index + 1}`,
    arte,
    detalle,
    label,
  };
}

function matchesStatusFilter(student, statusValue, includeInactive) {
  if (!includeInactive && !isStudentAllowedToLogIn(student)) {
    return false;
  }

  if (!statusValue || statusValue === "todos") return true;
  return normalizeStudentStatus(student) === statusValue;
}

function matchesAreaFilter(student, areaValue) {
  if (!areaValue) return true;

  if (normalizeText(student.area) === areaValue) return true;

  return Array.isArray(student.processes)
    ? student.processes.some((process) => normalizeText(process.arte) === areaValue)
    : false;
}

function matchesStudentQuery(student, queryValue) {
  if (!queryValue) return true;

  const hayMatch =
    normalizeText(student.nombre).includes(queryValue) ||
    normalizeText(student.interesesMusicales).includes(queryValue) ||
    normalizeText(student.email).includes(queryValue) ||
    normalizeText(student.docente).includes(queryValue) ||
    normalizeText(student.acudiente).includes(queryValue) ||
    normalizeText(student.programa).includes(queryValue) ||
    normalizeText(student.instrumento).includes(queryValue) ||
    normalizeText(student.documento).includes(queryValue) ||
    (Array.isArray(student.processes)
      ? student.processes.some((process) =>
          [
            process.arte,
            process.detalle,
            process.label,
          ].some((value) => normalizeText(value).includes(queryValue))
        )
      : false);

  return hayMatch;
}

function sortStudents(students = []) {
  return [...students].sort((a, b) =>
    normalizeScalar(a.nombre).localeCompare(normalizeScalar(b.nombre), "es", {
      sensitivity: "base",
    })
  );
}

async function listStudentsFromFirestore() {
  const snapshot = await getDocs(collection(db, STUDENTS_COLLECTION));
  return snapshot.docs
    .map((docSnap) => normalizeStudentRecord({ id: docSnap.id, ...docSnap.data() }))
    .filter(Boolean);
}

async function getStudentDocFromFirestore(studentRef) {
  const studentKey = normalizeStudentIdentifier(studentRef);
  if (!studentKey) return null;

  const snapshot = await getDoc(doc(db, STUDENTS_COLLECTION, studentKey));
  if (!snapshot.exists()) return null;

  return normalizeStudentRecord({ id: snapshot.id, ...snapshot.data() });
}

async function getStudentByEmailFromFirestore(email) {
  const safeEmail = normalizeScalar(email).toLowerCase();
  if (!safeEmail) return null;

  const snapshot = await getDocs(
    query(collection(db, STUDENTS_COLLECTION), where("email", "==", safeEmail), limit(1))
  );

  if (!snapshot?.docs?.length) return null;
  const first = snapshot.docs[0];
  return normalizeStudentRecord({ id: first.id, ...first.data() });
}

export async function getStudents(options = {}) {
  const filters = normalizeStudentQueryOptions(options);
  const students = await listStudentsFromFirestore();

  return sortStudents(
    students.filter(
      (student) =>
        matchesStatusFilter(student, filters.estado, filters.includeInactive) &&
        matchesAreaFilter(student, filters.arte) &&
        matchesStudentQuery(student, filters.q)
    )
  );
}

export async function getStudentsResponse(options = {}) {
  const students = await getStudents(options);

  return {
    ok: true,
    total: students.length,
    data: students,
    students,
    source: "firestore",
  };
}

export async function getStudentProfile(studentRef) {
  const student = await getStudentDocFromFirestore(studentRef);
  return student || null;
}

export async function getStudentByEmail(email) {
  const student = await getStudentByEmailFromFirestore(email);
  return student || null;
}

export async function getStudentProfileResponse(studentRef, options = {}) {
  const student = await getStudentProfile(studentRef, options);

  return {
    ok: true,
    data: student,
    student,
    profile: student,
    result: student,
    source: "firestore",
  };
}

export async function getStudentsFromSheet(options = {}) {
  const endpoint = resolveStudentsEndpoint();
  const queryParams = normalizeStudentQueryOptions(options);
  const url = buildUrl(endpoint, queryParams);
  const payload = await requestJson(url, {
    timeoutMs: options.timeoutMs,
  });

  return extractStudentsCollection(payload)
    .map(normalizeStudentRecord)
    .filter(Boolean);
}

export async function getStudentsResponseFromSheet(options = {}) {
  const students = await getStudentsFromSheet(options);

  return {
    ok: true,
    total: students.length,
    data: students,
    students,
    source: "apps_script",
  };
}

export async function getStudentProfileFromSheet(studentRef, options = {}) {
  const studentKey = normalizeStudentIdentifier(studentRef);

  if (!studentKey) {
    throw createApiError(
      "Se requiere studentKey para consultar el perfil del estudiante.",
      {
        code: "MISSING_STUDENT_KEY",
        studentRef,
      }
    );
  }

  const endpoint = resolveStudentProfileEndpoint();
  const url = buildUrl(endpoint, {
    studentKey,
    ...(isPlainObject(options.queryParams) ? options.queryParams : {}),
  });

  const payload = await requestJson(url, {
    timeoutMs: options.timeoutMs,
  });

  return normalizeStudentRecord(extractSingleStudent(payload));
}

export async function getStudentByEmailFromSheet(email, options = {}) {
  const safeEmail = normalizeScalar(email).toLowerCase();

  if (!safeEmail) {
    throw createApiError(
      "Se requiere email para consultar el perfil del estudiante.",
      {
        code: "MISSING_STUDENT_EMAIL",
        email,
      }
    );
  }

  const endpoint = resolveStudentProfileEndpoint();
  const url = buildUrl(endpoint, {
    email: safeEmail,
    ...(isPlainObject(options.queryParams) ? options.queryParams : {}),
  });

  const payload = await requestJson(url, {
    timeoutMs: options.timeoutMs,
  });

  return normalizeStudentRecord(extractSingleStudent(payload));
}

function createEmptyStudentSyncReport() {
  return {
    totalStudentsRead: 0,
    validStudents: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skippedInvalid: 0,
    synced: 0,
    source: "apps_script_to_firestore",
  };
}

function chunkArray(items = [], size = FIRESTORE_BATCH_LIMIT) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function hasStudentChanges(existingStudent, nextStudent) {
  if (!existingStudent) return true;

  const keys = [
    "nombre",
    "email",
    "correo",
    "correoElectronico",
    "edad",
    "estado",
    "interesesMusicales",
    "curso",
    "area",
    "programa",
    "instrumento",
    "modalidad",
    "sede",
    "docente",
    "acudiente",
    "sourceRow",
  ];

  for (const key of keys) {
    if (toStringSafe(existingStudent[key]) !== toStringSafe(nextStudent[key])) {
      return true;
    }
  }

  const existingProcesses = JSON.stringify(existingStudent.processes || []);
  const nextProcesses = JSON.stringify(nextStudent.processes || []);

  return existingProcesses !== nextProcesses;
}

export async function syncStudentsFromSheetToFirestore(options = {}) {
  const report = createEmptyStudentSyncReport();
  const studentsFromSheet = await getStudentsFromSheet({
    includeInactive: true,
    estado: "todos",
    timeoutMs: options.timeoutMs,
  });

  report.totalStudentsRead = studentsFromSheet.length;

  const existingStudents = await listStudentsFromFirestore();
  const existingById = new Map(
    existingStudents.map((student) => [student.studentKey || student.id, student])
  );

  const operations = [];

  studentsFromSheet.forEach((student) => {
    const normalized = normalizeStudentRecord(student);

    if (!normalized?.studentKey) {
      report.skippedInvalid += 1;
      return;
    }

    report.validStudents += 1;

    const existing = existingById.get(normalized.studentKey) || null;
    const payload = {
      ...normalized,
      source: "students_sheet_sync",
      syncOrigin: "settings_view",
      updatedAt: serverTimestamp(),
    };

    if (!existing) {
      payload.createdAt = serverTimestamp();
    }

    if (!hasStudentChanges(existing, normalized)) {
      report.unchanged += 1;
      return;
    }

    operations.push({
      id: normalized.studentKey,
      payload,
    });

    if (existing) {
      report.updated += 1;
    } else {
      report.created += 1;
    }
  });

  for (const chunk of chunkArray(operations)) {
    const batch = writeBatch(db);

    chunk.forEach((operation) => {
      batch.set(doc(db, STUDENTS_COLLECTION, operation.id), operation.payload, {
        merge: true,
      });
    });

    await batch.commit();
  }

  report.synced = report.created + report.updated;
  return report;
}

export {
  createApiError,
  buildUrl,
  requestJson,
  extractStudentsCollection,
  extractSingleStudent,
  normalizeStudentIdentifier,
  normalizeStudentRecord,
};

export default {
  getStudents,
  getStudentsResponse,
  getStudentProfile,
  getStudentProfileResponse,
  getStudentByEmail,
  getStudentsFromSheet,
  getStudentsResponseFromSheet,
  getStudentProfileFromSheet,
  getStudentByEmailFromSheet,
  syncStudentsFromSheetToFirestore,
  normalizeStudentStatus,
  isStudentAllowedToLogIn,
};

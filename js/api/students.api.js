// js/api/students.api.js

import { CONFIG, getApiUrl } from "../config.js";
import {
  isPlainObject,
  normalizeText,
  toStringSafe,
} from "../utils/shared.js";

const DEFAULT_TIMEOUT =
  Number.isFinite(CONFIG?.api?.timeoutMs) && CONFIG.api.timeoutMs > 0
    ? CONFIG.api.timeoutMs
    : 20000;

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

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
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
  if (!isNonEmptyString(baseUrl)) {
    throw createApiError("La URL base del endpoint no es válida.", {
      code: "INVALID_URL",
      baseUrl,
    });
  }

  let url;
  try {
    url = new URL(baseUrl);
  } catch (error) {
    throw createApiError("La URL del endpoint no tiene un formato válido.", {
      code: "INVALID_URL_FORMAT",
      baseUrl,
      cause: error,
    });
  }

  Object.entries(queryParams).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    url.searchParams.set(key, String(value));
  });

  return url.toString();
}

async function parseJsonResponse(response) {
  const rawText = await response.text();

  if (!rawText || !rawText.trim()) {
    throw createApiError("La respuesta del servidor llegó vacía.", {
      code: "EMPTY_RESPONSE",
      status: response.status,
    });
  }

  try {
    return JSON.parse(rawText);
  } catch (error) {
    throw createApiError("La respuesta del servidor no es JSON válido.", {
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

  const headers = {
    Accept: "application/json",
    ...(options.headers || {}),
  };

  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body,
      signal,
      redirect: "follow",
      cache: "no-store",
    });

    const payload = await parseJsonResponse(response);

    if (!response.ok) {
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

    if (payload?.ok === false || payload?.success === false) {
      throw createApiError(
        payload?.message ||
          payload?.error ||
          "El servidor respondió con un error.",
        {
          code: "API_ERROR",
          status: response.status,
          payload,
          url,
        }
      );
    }

    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw createApiError("La solicitud tardó demasiado y fue cancelada.", {
        code: "REQUEST_TIMEOUT",
        url,
      });
    }

    if (error instanceof Error) {
      throw error;
    }

    throw createApiError(
      "Ocurrió un error inesperado al consultar el servidor.",
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
        config: CONFIG,
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
        config: CONFIG,
      }
    );
  }

  return url;
}

function resolveTeachersEndpoint() {
  const url = getApiUrl("teachers");

  if (!url) {
    throw createApiError(
      'No se pudo resolver el endpoint "teachers" desde config.js.',
      {
        code: "MISSING_TEACHERS_ENDPOINT",
        config: CONFIG,
      }
    );
  }

  return url;
}

function extractStudentsCollection(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!isPlainObject(payload)) {
    throw createApiError(
      "La respuesta de estudiantes tiene un formato inválido.",
      {
        code: "INVALID_STUDENTS_FORMAT",
        payload,
      }
    );
  }

  if (Array.isArray(payload.data)) {
    return payload.data;
  }

  if (Array.isArray(payload.students)) {
    return payload.students;
  }

  if (isPlainObject(payload.data) && Array.isArray(payload.data.students)) {
    return payload.data.students;
  }

  if (Array.isArray(payload.results)) {
    return payload.results;
  }

  return [];
}

function extractTeachersCollection(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!isPlainObject(payload)) {
    throw createApiError(
      "La respuesta de docentes tiene un formato inválido.",
      {
        code: "INVALID_TEACHERS_FORMAT",
        payload,
      }
    );
  }

  if (Array.isArray(payload.data)) {
    return payload.data;
  }

  if (Array.isArray(payload.teachers)) {
    return payload.teachers;
  }

  if (isPlainObject(payload.data) && Array.isArray(payload.data.teachers)) {
    return payload.data.teachers;
  }

  if (Array.isArray(payload.results)) {
    return payload.results;
  }

  return [];
}

function extractSingleStudent(payload) {
  if (Array.isArray(payload)) {
    return payload.length ? payload[0] : null;
  }

  if (!isPlainObject(payload)) {
    throw createApiError(
      "La respuesta del perfil del estudiante tiene un formato inválido.",
      {
        code: "INVALID_STUDENT_PROFILE_FORMAT",
        payload,
      }
    );
  }

  if (isPlainObject(payload.data)) {
    return payload.data;
  }

  if (isPlainObject(payload.student)) {
    return payload.student;
  }

  if (isPlainObject(payload.profile)) {
    return payload.profile;
  }

  if (isPlainObject(payload.result)) {
    return payload.result;
  }

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
  const query =
    options.query ??
    options.q ??
    options.search ??
    "";

  const includeInactive =
    typeof options.includeInactive === "boolean"
      ? options.includeInactive
      : true;

  const status =
    options.estado ||
    options.status ||
    (includeInactive ? "todos" : "");

  return {
    q: normalizeScalar(query),
    estado: normalizeScalar(status),
    arte: normalizeScalar(options.arte || options.area),
    includeInactive,
  };
}

function normalizeTeacherQueryOptions(options = {}) {
  const query =
    options.query ??
    options.q ??
    options.search ??
    "";

  const includeInactive =
    typeof options.includeInactive === "boolean"
      ? options.includeInactive
      : false;

  return {
    q: normalizeScalar(query),
    includeInactive,
  };
}

/**
 * Obtiene la lista cruda de estudiantes desde Apps Script.
 * Mantiene el contrato flexible, pero alineado al backend actual.
 *
 * Parámetros útiles:
 * - query / q / search
 * - estado
 * - arte
 * - includeInactive
 */
export async function getStudents(options = {}) {
  const endpoint = resolveStudentsEndpoint();
  const queryParams = normalizeStudentQueryOptions(options);

  const url = buildUrl(endpoint, queryParams);

  const payload = await requestJson(url, {
    timeoutMs: options.timeoutMs,
  });

  return extractStudentsCollection(payload);
}

/**
 * Obtiene el payload completo de estudiantes.
 * Útil si alguna capa necesita total, ok, data, etc.
 */
export async function getStudentsResponse(options = {}) {
  const endpoint = resolveStudentsEndpoint();
  const queryParams = normalizeStudentQueryOptions(options);

  const url = buildUrl(endpoint, queryParams);

  return requestJson(url, {
    timeoutMs: options.timeoutMs,
  });
}

export async function getTeachers(options = {}) {
  const endpoint = resolveTeachersEndpoint();
  const queryParams = normalizeTeacherQueryOptions(options);
  const url = buildUrl(endpoint, queryParams);
  const payload = await requestJson(url, {
    timeoutMs: options.timeoutMs,
  });

  return extractTeachersCollection(payload);
}

export async function getTeachersResponse(options = {}) {
  const endpoint = resolveTeachersEndpoint();
  const queryParams = normalizeTeacherQueryOptions(options);
  const url = buildUrl(endpoint, queryParams);

  return requestJson(url, {
    timeoutMs: options.timeoutMs,
  });
}

/**
 * Obtiene el perfil crudo de un estudiante específico.
 * El backend actual espera studentKey.
 */
export async function getStudentProfile(studentRef, options = {}) {
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

  const student = extractSingleStudent(payload);

  if (!student) {
    return null;
  }

  if (!isPlainObject(student)) {
    throw createApiError(
      "El perfil del estudiante no tiene un formato de objeto válido.",
      {
        code: "INVALID_STUDENT_PROFILE_OBJECT",
        payload,
      }
    );
  }

  return student;
}

export async function getStudentByEmail(email, options = {}) {
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

  const student = extractSingleStudent(payload);

  if (!student) {
    return null;
  }

  if (!isPlainObject(student)) {
    throw createApiError(
      "El perfil del estudiante por email no tiene un formato de objeto valido.",
      {
        code: "INVALID_STUDENT_EMAIL_PROFILE_OBJECT",
        payload,
      }
    );
  }

  return student;
}

/**
 * Igual que getStudentProfile pero devuelve el payload completo.
 * Sirve para debugging o para futuras necesidades del service/view.
 */
export async function getStudentProfileResponse(studentRef, options = {}) {
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

  return requestJson(url, {
    timeoutMs: options.timeoutMs,
  });
}

export {
  createApiError,
  buildUrl,
  requestJson,
  extractStudentsCollection,
  extractTeachersCollection,
  extractSingleStudent,
  normalizeStudentIdentifier,
};

export default {
  getStudents,
  getStudentsResponse,
  getTeachers,
  getTeachersResponse,
  getStudentProfile,
  getStudentProfileResponse,
  normalizeStudentStatus,
  isStudentAllowedToLogIn,
};

// js/config.js

const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
]);

const APP_VERSION = "1.1.0";

function detectEnvironment() {
  const hostname = window.location.hostname || "";
  return LOCAL_HOSTNAMES.has(hostname) ? "development" : "production";
}

const ENV = detectEnvironment();

/*
  Una sola URL del Apps Script para todo (API y uploads, dev y produccion).
  Cuando se cree una nueva implementacion en Apps Script, solo se cambia aqui.
*/
const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbyPaqPmViYGR3dv5REoyWzoCTxOMsY3xCIKdux5vqSAkCQg35SniHB9DnYI4IHit4sVqA/exec";

const BASE_URLS = {
  development: {
    appsScript: APPS_SCRIPT_URL,
    uploads: APPS_SCRIPT_URL,
  },
  production: {
    appsScript: APPS_SCRIPT_URL,
    uploads: APPS_SCRIPT_URL,
  },
};

const APP_ROUTES = Object.freeze({
  search: "search",
  profile: "profile",
  editor: "editor",
  compare: "compare",
  planeador: "planeador",
  settings: "settings",
});

const APP_MODES = Object.freeze({
  individual: "individual",
  group: "group",
});

const APP_ROLES = Object.freeze({
  admin: "admin",
  teacher: "teacher",
});

const STORAGE_KEYS = Object.freeze({
  session: "bitacoras_session",
  lastStudentId: "bitacoras_last_student_id",
  lastSearch: "bitacoras_last_search",
  draftPrefix: "bitacoras_draft_",
  groupDraftPrefix: "bitacoras_group_draft_",
  lastRoute: "bitacoras_last_route",
  editorMode: "bitacoras_editor_mode",
  authUser: "bitacoras_auth_user",
  selectedStudentIds: "bitacoras_selected_student_ids",
  routeProgress: "bitacoras_route_progress",
  routeGoals: "bitacoras_route_goals",
});

const APP_LIMITS = Object.freeze({
  searchDebounceMs: 250,
  autosaveDebounceMs: 800,
  maxSearchResults: 50,
  maxBitacoraLength: 5000,
  maxTitleLength: 140,
  maxTags: 10,
  maxRecentBitacoras: 50,
  maxUploadFiles: 5,
  maxUploadSizeMb: 15,
});

const UI_TEXT = Object.freeze({
  appName: "Bitácoras de Clase",
  emptySearch: "Escribe algo para buscar estudiantes.",
  emptyStudents: "No se encontraron estudiantes.",
  emptyBitacoras: "Este estudiante aún no tiene bitácoras registradas.",
  emptyGroup: "Selecciona al menos dos estudiantes para una bitácora grupal.",
  loading: "Cargando...",
  saving: "Guardando...",
  saveSuccess: "Bitácora guardada correctamente.",
  saveError: "No se pudo guardar la bitácora.",
  uploadError: "No se pudieron subir los archivos.",
  genericError: "Ocurrió un error inesperado.",
  firebaseNotReady:
    "Firebase aún no está habilitado para guardar bitácoras. Revisa la configuración del proyecto.",
});

const API_ENDPOINTS = Object.freeze({
  students: "students",
  studentProfile: "student",
  teachers: "teachers",
  bitacoras: "bitacoras",
  bitacoraByStudent: "bitacoras-by-student",
  upload: "upload",
});

const FEATURE_FLAGS = Object.freeze({
  enableFirestoreBitacoras: true,
  enableGroupBitacoras: true,
});

const FIRESTORE_CONFIG = Object.freeze({
  studentsCollection: "students",
  bitacorasCollection: "bitacoras",
  routeTemplatesCollection: "route_templates",
  studentRoutesCollection: "student_routes",
  studentRouteProgressCollection: "student_route_progress",
  appConfigCollection: "app_config",
  catalogsDocumentId: "catalogos",
  planeacionesCollection: "planeaciones",
  planeadorPostitsCollection: "planeador_postits",
});

const ACTIVE_BASE_URLS = BASE_URLS[ENV] || BASE_URLS.production;

export const CONFIG = Object.freeze({
  env: ENV,
  debug: ENV === "development",

  app: Object.freeze({
    name: UI_TEXT.appName,
    version: APP_VERSION,
    defaultRoute: APP_ROUTES.search,
  }),

  routes: APP_ROUTES,
  modes: APP_MODES,
  roles: APP_ROLES,
  storage: STORAGE_KEYS,
  limits: APP_LIMITS,
  text: UI_TEXT,
  features: FEATURE_FLAGS,

  api: Object.freeze({
    baseUrl: ACTIVE_BASE_URLS.appsScript,
    timeoutMs: 20000,
    endpoints: API_ENDPOINTS,
  }),

  uploads: Object.freeze({
    baseUrl: ACTIVE_BASE_URLS.uploads,
    allowedTypes: Object.freeze([
      "image/jpeg",
      "image/png",
      "image/webp",
      "video/mp4",
      "video/webm",
      "audio/mpeg",
      "audio/mp3",
      "audio/webm",
      "audio/wav",
      "application/pdf",
    ]),
    maxFiles: APP_LIMITS.maxUploadFiles,
    maxSizeBytes: APP_LIMITS.maxUploadSizeMb * 1024 * 1024,
  }),

  firestore: FIRESTORE_CONFIG,

  access: Object.freeze({
    bootstrapAdminEmails: Object.freeze([
      "alekcaballeromusic@gmail.com",
      "catalina.medina.leal@gmail.com",
      "imusicala@gmail.com",
      "adminmusicala@gmail.com",
    ]),
  }),
});

function ensureBaseUrl(baseUrl, sourceLabel) {
  const safeBaseUrl = String(baseUrl || "").trim();

  if (!safeBaseUrl) {
    throw new Error(
      `Falta configurar la URL base de ${sourceLabel} para el entorno "${CONFIG.env}".`
    );
  }

  return safeBaseUrl;
}

function appendQueryParams(baseUrl, params = {}) {
  const url = new URL(baseUrl);

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    url.searchParams.set(key, String(value));
  });

  return url.toString();
}

export function getApiUrl(endpointKey, extraParams = {}) {
  const endpoint = CONFIG.api.endpoints[endpointKey];

  if (!endpoint) {
    throw new Error(`Endpoint no configurado: ${endpointKey}`);
  }

  const baseUrl = ensureBaseUrl(CONFIG.api.baseUrl, "CONFIG.api.baseUrl");

  return appendQueryParams(baseUrl, {
    action: endpoint,
    ...extraParams,
  });
}

export function getUploadUrl(extraParams = {}) {
  const baseUrl = ensureBaseUrl(
    CONFIG.uploads.baseUrl,
    "CONFIG.uploads.baseUrl"
  );

  return Object.keys(extraParams).length
    ? appendQueryParams(baseUrl, extraParams)
    : baseUrl;
}

function toStringSafe(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function uniqueStrings(values = []) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((item) => toStringSafe(item))
        .filter(Boolean)
    ),
  ];
}

export function buildDraftKey(studentId) {
  const safeStudentId = toStringSafe(studentId);

  if (!safeStudentId) {
    throw new Error("No se puede construir el draft key sin studentId.");
  }

  return `${CONFIG.storage.draftPrefix}${safeStudentId}`;
}

export function buildGroupDraftKey(studentIds = []) {
  const safeIds = uniqueStrings(studentIds).sort();

  if (!safeIds.length) {
    throw new Error(
      "No se puede construir el draft grupal sin studentIds válidos."
    );
  }

  return `${CONFIG.storage.groupDraftPrefix}${safeIds.join("__")}`;
}

export function getDefaultEditorState() {
  return {
    mode: CONFIG.modes.individual,
    selectedStudentIds: [],
    attachments: [],
    title: "",
    content: "",
    tags: [],
    fechaClase: "",
  };
}

export function canUseGroupBitacoras() {
  return Boolean(CONFIG.features.enableGroupBitacoras);
}

export function canUseFirestoreBitacoras() {
  return Boolean(CONFIG.features.enableFirestoreBitacoras);
}

export function getBitacorasCollectionName() {
  return CONFIG.firestore.bitacorasCollection || "bitacoras";
}

export function getStudentsCollectionName() {
  return CONFIG.firestore.studentsCollection || "students";
}

export function getStudentRoutesCollectionName() {
  return CONFIG.firestore.studentRoutesCollection || "student_routes";
}

export function getRouteTemplatesCollectionName() {
  return CONFIG.firestore.routeTemplatesCollection || "route_templates";
}

export function getStudentRouteProgressCollectionName() {
  return CONFIG.firestore.studentRouteProgressCollection || "student_route_progress";
}

export function getAppConfigCollectionName() {
  return CONFIG.firestore.appConfigCollection || "app_config";
}

export function getCatalogsDocumentId() {
  return CONFIG.firestore.catalogsDocumentId || "catalogos";
}

export function getPlaneacionesCollectionName() {
  return CONFIG.firestore.planeacionesCollection || "planeaciones";
}

export function getPlaneadorPostitsCollectionName() {
  return CONFIG.firestore.planeadorPostitsCollection || "planeador_postits";
}

export function assertValidBitacoraMode(mode) {
  const safeMode = toStringSafe(mode);

  if (
    safeMode !== CONFIG.modes.individual &&
    safeMode !== CONFIG.modes.group
  ) {
    throw new Error(`Modo de bitácora inválido: ${safeMode || "(vacío)"}`);
  }

  return safeMode;
}

export function isDebugEnabled() {
  return CONFIG.debug;
}

export function isValidRoute(route) {
  return Object.values(CONFIG.routes).includes(route);
}

// js/utils/constants.js

/**
 * Constantes globales reutilizables de la app Bitácoras de clase
 * - Sin lógica
 * - Sin DOM
 * - Sin fetch
 * - Sin side effects
 */

/* ==========================================================================
   APP
   ========================================================================== */

export const APP_NAME = 'Bitácoras de clase';
export const APP_VERSION = '1.0.0';

/* ==========================================================================
   STATE KEYS
   ========================================================================== */

export const STATE_KEYS = Object.freeze({
  APP: 'app',
  SEARCH: 'search',
  STUDENTS: 'students',
  STUDENT: 'student',
  PROFILE: 'profile',
  BITACORAS: 'bitacoras',
  BITACORA: 'bitacora',
  FORM: 'form',
  FILTERS: 'filters',
  UI: 'ui',
  UPLOADS: 'uploads'
});

/* ==========================================================================
   VIEW IDS
   ========================================================================== */

export const VIEW_IDS = Object.freeze({
  SEARCH: 'search',
  PROFILE: 'profile',
  EDITOR: 'editor'
});

/* ==========================================================================
   ACCIONES / MODOS
   ========================================================================== */

export const ACTIONS = Object.freeze({
  CREATE: 'create',
  EDIT: 'edit',
  VIEW: 'view',
  DELETE: 'delete',
  SELECT: 'select',
  CLEAR: 'clear',
  SEARCH: 'search',
  FILTER: 'filter',
  UPLOAD: 'upload'
});

export const FORM_MODES = Object.freeze({
  CREATE: 'create',
  EDIT: 'edit',
  DUPLICATE: 'duplicate'
});

/* ==========================================================================
   TIPOS DE BITÁCORA
   ========================================================================== */

export const BITACORA_TYPES = Object.freeze({
  GENERAL: 'general',
  PEDAGOGICA: 'pedagogica',
  COMPORTAMENTAL: 'comportamental',
  EMOCIONAL: 'emocional',
  TECNICA: 'tecnica',
  SEGUIMIENTO: 'seguimiento',
  OBSERVACION: 'observacion',
  LOGRO: 'logro',
  DIFICULTAD: 'dificultad'
});

export const BITACORA_TYPE_OPTIONS = Object.freeze([
  { value: BITACORA_TYPES.GENERAL, label: 'General' },
  { value: BITACORA_TYPES.PEDAGOGICA, label: 'Pedagógica' },
  { value: BITACORA_TYPES.COMPORTAMENTAL, label: 'Comportamental' },
  { value: BITACORA_TYPES.EMOCIONAL, label: 'Emocional' },
  { value: BITACORA_TYPES.TECNICA, label: 'Técnica' },
  { value: BITACORA_TYPES.SEGUIMIENTO, label: 'Seguimiento' },
  { value: BITACORA_TYPES.OBSERVACION, label: 'Observación' },
  { value: BITACORA_TYPES.LOGRO, label: 'Logro' },
  { value: BITACORA_TYPES.DIFICULTAD, label: 'Dificultad' }
]);

/* ==========================================================================
   ESTADOS
   ========================================================================== */

export const STATUS = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading',
  SUCCESS: 'success',
  ERROR: 'error',
  EMPTY: 'empty',
  READY: 'ready'
});

export const RECORD_STATUS = Object.freeze({
  ACTIVE: 'active',
  ARCHIVED: 'archived',
  DRAFT: 'draft',
  DELETED: 'deleted'
});

export const PROCESS_STATUS = Object.freeze({
  PENDING: 'pending',
  UPLOADING: 'uploading',
  SAVING: 'saving',
  DONE: 'done',
  FAILED: 'failed'
});

/* ==========================================================================
   FILTROS
   ========================================================================== */

export const FILTER_KEYS = Object.freeze({
  QUERY: 'query',
  TYPE: 'type',
  STATUS: 'status',
  DATE_FROM: 'dateFrom',
  DATE_TO: 'dateTo',
  AUTHOR: 'author'
});

export const DEFAULT_FILTERS = Object.freeze({
  query: '',
  type: '',
  status: '',
  dateFrom: '',
  dateTo: '',
  author: ''
});

/* ==========================================================================
   CAMPOS FRECUENTES
   ========================================================================== */

export const STUDENT_FIELDS = Object.freeze({
  ID: 'id',
  NAME: 'name',
  FIRST_NAME: 'firstName',
  LAST_NAME: 'lastName',
  FULL_NAME: 'fullName',
  DOCUMENT: 'document',
  AGE: 'age',
  BIRTHDATE: 'birthdate',
  PHONE: 'phone',
  EMAIL: 'email',
  INSTRUMENT: 'instrument',
  MODALITY: 'modality',
  PROGRAM: 'program',
  LEVEL: 'level',
  TEACHER: 'teacher',
  STATUS: 'status',
  SEARCH_TEXT: 'searchText',
  CREATED_AT: 'createdAt',
  UPDATED_AT: 'updatedAt'
});

export const BITACORA_FIELDS = Object.freeze({
  ID: 'id',
  STUDENT_ID: 'studentId',
  TITLE: 'title',
  CONTENT: 'content',
  TYPE: 'type',
  STATUS: 'status',
  TAGS: 'tags',
  AUTHOR: 'author',
  AUTHOR_ID: 'authorId',
  FILES: 'files',
  FILE_COUNT: 'fileCount',
  SEARCH_TEXT: 'searchText',
  CREATED_AT: 'createdAt',
  UPDATED_AT: 'updatedAt',
  CLASS_DATE: 'classDate'
});

/* ==========================================================================
   ARCHIVOS / UPLOADS
   ========================================================================== */

export const FILE_LIMITS = Object.freeze({
  MAX_FILES: 5,
  MAX_FILE_SIZE_MB: 20,
  MAX_FILE_SIZE_BYTES: 20 * 1024 * 1024,
  MAX_TOTAL_SIZE_MB: 50,
  MAX_TOTAL_SIZE_BYTES: 50 * 1024 * 1024
});

export const FILE_ACCEPT = Object.freeze({
  IMAGES: 'image/*',
  VIDEOS: 'video/*',
  DOCUMENTS: '.pdf,.doc,.docx,.txt',
  ALL_SUPPORTED: 'image/*,video/*,.pdf,.doc,.docx,.txt'
});

export const FILE_TYPES = Object.freeze({
  IMAGE: 'image',
  VIDEO: 'video',
  DOCUMENT: 'document',
  OTHER: 'other'
});

export const FILE_EXTENSIONS = Object.freeze({
  IMAGE: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
  VIDEO: ['mp4', 'mov', 'webm', 'm4v'],
  DOCUMENT: ['pdf', 'doc', 'docx', 'txt']
});

/* ==========================================================================
   VALIDACIONES / LÍMITES DE FORMULARIO
   ========================================================================== */

export const TEXT_LIMITS = Object.freeze({
  SEARCH_MIN: 2,
  SEARCH_MAX: 100,
  TITLE_MIN: 3,
  TITLE_MAX: 120,
  CONTENT_MIN: 5,
  CONTENT_MAX: 5000,
  EXCERPT_LENGTH: 140,
  NAME_MAX: 120,
  TAG_MAX: 30
});

export const PAGINATION = Object.freeze({
  DEFAULT_PAGE: 1,
  DEFAULT_PAGE_SIZE: 10,
  MAX_PAGE_SIZE: 50
});

/* ==========================================================================
   STORAGE / CACHE KEYS
   ========================================================================== */

export const STORAGE_KEYS = Object.freeze({
  LAST_STUDENT_ID: 'bitacoras:lastStudentId',
  LAST_VIEW: 'bitacoras:lastView',
  DRAFT_BITACORA: 'bitacoras:draft',
  SEARCH_QUERY: 'bitacoras:searchQuery',
  FILTERS: 'bitacoras:filters'
});

/* ==========================================================================
   MENSAJES REUTILIZABLES
   ========================================================================== */

export const UI_TEXT = Object.freeze({
  EMPTY_SEARCH: 'Escribe algo para buscar estudiantes.',
  NO_RESULTS: 'No se encontraron estudiantes.',
  NO_STUDENT_SELECTED: 'Selecciona un estudiante para continuar.',
  NO_BITACORAS: 'Este estudiante aún no tiene bitácoras.',
  LOADING_STUDENTS: 'Cargando estudiantes...',
  LOADING_PROFILE: 'Cargando perfil...',
  LOADING_BITACORAS: 'Cargando bitácoras...',
  SAVING: 'Guardando...',
  SAVED: 'Bitácora guardada correctamente.',
  UPDATED: 'Bitácora actualizada correctamente.',
  DELETED: 'Bitácora eliminada correctamente.',
  ERROR_GENERIC: 'Ocurrió un error. Intenta nuevamente.',
  ERROR_SAVE: 'No fue posible guardar la bitácora.',
  ERROR_UPLOAD: 'No fue posible subir el archivo.',
  INVALID_FORM: 'Revisa los campos obligatorios.',
  INVALID_FILE_TYPE: 'Ese tipo de archivo no está permitido.',
  INVALID_FILE_SIZE: 'El archivo supera el tamaño permitido.',
  TOO_MANY_FILES: 'Superaste la cantidad máxima de archivos.'
});

/* ==========================================================================
   ETIQUETAS AMIGABLES (fallback útil)
   ========================================================================== */

export const STATUS_LABELS = Object.freeze({
  [STATUS.IDLE]: 'Inactivo',
  [STATUS.LOADING]: 'Cargando',
  [STATUS.SUCCESS]: 'Éxito',
  [STATUS.ERROR]: 'Error',
  [STATUS.EMPTY]: 'Vacío',
  [STATUS.READY]: 'Listo',
  [RECORD_STATUS.ACTIVE]: 'Activo',
  [RECORD_STATUS.ARCHIVED]: 'Archivado',
  [RECORD_STATUS.DRAFT]: 'Borrador',
  [RECORD_STATUS.DELETED]: 'Eliminado',
  [PROCESS_STATUS.PENDING]: 'Pendiente',
  [PROCESS_STATUS.UPLOADING]: 'Subiendo',
  [PROCESS_STATUS.SAVING]: 'Guardando',
  [PROCESS_STATUS.DONE]: 'Completado',
  [PROCESS_STATUS.FAILED]: 'Falló'
});

export const TYPE_LABELS = Object.freeze({
  [BITACORA_TYPES.GENERAL]: 'General',
  [BITACORA_TYPES.PEDAGOGICA]: 'Pedagógica',
  [BITACORA_TYPES.COMPORTAMENTAL]: 'Comportamental',
  [BITACORA_TYPES.EMOCIONAL]: 'Emocional',
  [BITACORA_TYPES.TECNICA]: 'Técnica',
  [BITACORA_TYPES.SEGUIMIENTO]: 'Seguimiento',
  [BITACORA_TYPES.OBSERVACION]: 'Observación',
  [BITACORA_TYPES.LOGRO]: 'Logro',
  [BITACORA_TYPES.DIFICULTAD]: 'Dificultad'
});

/* ==========================================================================
   DEFAULTS DE ENTIDADES
   ========================================================================== */

export const DEFAULT_STUDENT = Object.freeze({
  id: '',
  name: '',
  firstName: '',
  lastName: '',
  fullName: '',
  document: '',
  age: '',
  birthdate: '',
  phone: '',
  email: '',
  instrument: '',
  modality: '',
  program: '',
  level: '',
  teacher: '',
  status: '',
  searchText: '',
  createdAt: '',
  updatedAt: ''
});

export const DEFAULT_BITACORA = Object.freeze({
  id: '',
  studentId: '',
  title: '',
  content: '',
  type: BITACORA_TYPES.GENERAL,
  status: RECORD_STATUS.ACTIVE,
  tags: [],
  author: '',
  authorId: '',
  files: [],
  fileCount: 0,
  searchText: '',
  classDate: '',
  createdAt: '',
  updatedAt: ''
});
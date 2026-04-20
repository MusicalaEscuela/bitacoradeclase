// js/api/bitacoras.api.js

import {
  CONFIG,
  assertValidBitacoraMode,
  canUseFirestoreBitacoras,
  getBitacorasCollectionName,
} from "../config.js";

import {
  db,
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  updateDoc,
  serverTimestamp,
  normalizeTimestamps,
  getCurrentUser,
} from "../firebase.client.js";

import {
  isPlainObject,
  toStringSafe,
  uniqueStrings,
} from "../utils/shared.js";

const BITACORAS_COLLECTION = getBitacorasCollectionName();
const DEFAULT_LIMIT = 50;

function createApiError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

function assertFirestoreEnabled() {
  if (!canUseFirestoreBitacoras()) {
    throw createApiError(CONFIG.text.firebaseNotReady, {
      code: "FIRESTORE_DISABLED",
    });
  }
}

function assertAuthenticated() {
  const currentUser = getCurrentUser();

  if (!currentUser?.uid) {
    throw createApiError(
      "Debes iniciar sesión con Google para consultar o guardar bitácoras.",
      {
        code: "AUTH_REQUIRED",
      }
    );
  }

  return currentUser;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeString(value) {
  return toStringSafe(value);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStudentRefs(values = []) {
  const map = new Map();

  for (const item of safeArray(values)) {
    if (!isPlainObject(item)) continue;

    const id = safeString(item.id);
    const name = safeString(item.name);

    if (!id) continue;

    map.set(id, {
      id,
      name,
    });
  }

  return [...map.values()];
}

function normalizeStoredMode(value) {
  try {
    return assertValidBitacoraMode(value || CONFIG.modes.individual);
  } catch {
    return CONFIG.modes.individual;
  }
}

function normalizeAuthor(author = {}) {
  if (!isPlainObject(author)) {
    return {
      uid: "",
      name: "",
      email: "",
      photoURL: "",
    };
  }

  return {
    uid: safeString(author.uid),
    name: safeString(author.name),
    email: safeString(author.email),
    photoURL: safeString(author.photoURL),
  };
}

function normalizeProcess(process = {}) {
  if (!isPlainObject(process)) {
    return {
      area: "",
      modalidad: "",
      docente: "",
      sede: "",
      programa: "",
    };
  }

  return {
    processKey: safeString(process.processKey || process.id || process.key),
    processLabel: safeString(process.processLabel || process.label),
    area: safeString(process.area),
    modalidad: safeString(process.modalidad),
    docente: safeString(process.docente),
    sede: safeString(process.sede),
    programa: safeString(process.programa),
  };
}

function normalizeAttachments(attachments = []) {
  return safeArray(attachments)
    .filter((item) => isPlainObject(item))
    .map((item) => ({
      name: safeString(item.name || item.nombre || "Archivo"),
      url: safeString(item.url),
      type: safeString(item.type),
      size: Number(item.size || 0),
      path: safeString(item.path),
      uploadedAt: item.uploadedAt || null,
    }))
    .filter((item) => item.url || item.path || item.name);
}

function normalizeTags(tags = []) {
  return uniqueStrings(tags).slice(0, CONFIG.limits.maxTags);
}

function normalizeOverrideValues(values = []) {
  const source = Array.isArray(values) ? values : [values];

  return uniqueStrings(
    source
      .flatMap((value) =>
        String(value || "")
          .split(/,|;|\n/g)
          .map((item) => safeString(item))
      )
      .filter(Boolean)
  );
}

function normalizeStudentOverridesFromPayload(payload = {}, studentIds = []) {
  const next = {};
  const allowedIds = new Set(uniqueStrings(studentIds));
  const source = isPlainObject(payload.studentOverrides)
    ? payload.studentOverrides
    : isPlainObject(payload.overrides)
    ? payload.overrides
    : {};

  Object.entries(source).forEach(([studentId, value]) => {
    const safeStudentId = safeString(studentId);
    if (!safeStudentId || (allowedIds.size && !allowedIds.has(safeStudentId))) {
      return;
    }

    const normalizedValue = isPlainObject(value) ? value : {};
    const enabled = Boolean(normalizedValue.enabled);
    const tareas = safeString(normalizedValue.tareas);
    const etiquetas = normalizeOverrideValues(normalizedValue.etiquetas);
    const componenteCorporal = normalizeOverrideValues(
      normalizedValue.componenteCorporal
    );
    const componenteTecnico = normalizeOverrideValues(
      normalizedValue.componenteTecnico
    );
    const componenteTeorico = normalizeOverrideValues(
      normalizedValue.componenteTeorico
    );
    const componenteObras = normalizeOverrideValues(
      normalizedValue.componenteObras
    );

    if (
      !enabled &&
      !tareas &&
      !etiquetas.length &&
      !componenteCorporal.length &&
      !componenteTecnico.length &&
      !componenteTeorico.length &&
      !componenteObras.length
    ) {
      return;
    }

    next[safeStudentId] = {
      enabled,
      tareas,
      etiquetas,
      componenteCorporal,
      componenteTecnico,
      componenteTeorico,
      componenteObras,
    };
  });

  return next;
}

function normalizeStudentIdsFromPayload(payload = {}) {
  const fromArray = uniqueStrings(payload.studentIds);
  const fromSingle = uniqueStrings([
    payload.studentId,
    payload.primaryStudentId,
  ]);

  return uniqueStrings([...fromArray, ...fromSingle]);
}

function normalizeStudentRefsFromPayload(payload = {}, studentIds = []) {
  const refs = uniqueStudentRefs(payload.studentRefs);

  if (refs.length) {
    return refs;
  }

  return studentIds.map((id) => ({
    id,
    name: "",
  }));
}

function normalizeBitacoraPayload(input = {}, options = {}) {
  if (!isPlainObject(input)) {
    throw createApiError("Los datos de la bitácora deben ser un objeto válido.", {
      code: "INVALID_BITACORA_PAYLOAD",
    });
  }

  const mode = assertValidBitacoraMode(
    input.mode || options.mode || CONFIG.modes.individual
  );

  const title = safeString(input.title || input.titulo);
  const content = safeString(input.content || input.contenido);
  const fechaClase = safeString(input.fechaClase || input.fecha || "");
  const tags = normalizeTags(input.tags || input.etiquetas);
  const attachments = normalizeAttachments(
    input.attachments || input.archivos || []
  );
  const author = normalizeAuthor(input.author);
  const process = normalizeProcess(input.process);

  const studentIds = normalizeStudentIdsFromPayload(input);
  const studentRefs = normalizeStudentRefsFromPayload(input, studentIds);
  const studentOverrides = normalizeStudentOverridesFromPayload(input, studentIds);
  const primaryStudentId =
    safeString(input.primaryStudentId) || studentIds[0] || "";

  if (!studentIds.length) {
    throw createApiError("La bitácora debe tener al menos un estudiante relacionado.", {
      code: "BITACORA_REQUIRES_STUDENTS",
    });
  }

  if (!content) {
    throw createApiError("La bitácora no puede guardarse sin contenido.", {
      code: "BITACORA_REQUIRES_CONTENT",
    });
  }

  if (content.length > CONFIG.limits.maxBitacoraLength) {
    throw createApiError(
      `La bitácora supera el máximo de ${CONFIG.limits.maxBitacoraLength} caracteres.`,
      {
        code: "BITACORA_CONTENT_TOO_LONG",
      }
    );
  }

  if (title.length > CONFIG.limits.maxTitleLength) {
    throw createApiError(
      `El título supera el máximo de ${CONFIG.limits.maxTitleLength} caracteres.`,
      {
        code: "BITACORA_TITLE_TOO_LONG",
      }
    );
  }

  if (mode === CONFIG.modes.group && studentIds.length < 2) {
    throw createApiError(CONFIG.text.emptyGroup, {
      code: "GROUP_BITACORA_REQUIRES_MULTIPLE_STUDENTS",
    });
  }

  if (mode === CONFIG.modes.individual && studentIds.length > 1) {
    throw createApiError(
      "Una bitácora individual no debería tener varios estudiantes.",
      {
        code: "INDIVIDUAL_BITACORA_HAS_MULTIPLE_STUDENTS",
      }
    );
  }

  if (!author.uid) {
    throw createApiError("La bitácora necesita un autor autenticado.", {
      code: "BITACORA_REQUIRES_AUTHOR",
    });
  }

  return {
    mode,
    title,
    content,
    fechaClase,
    studentIds,
    studentRefs,
    studentOverrides,
    primaryStudentId,
    author,
    process,
    tags,
    attachments,
    status: safeString(input.status || "active"),
    source: safeString(input.source || "app"),
    metadata: isPlainObject(input.metadata) ? input.metadata : {},
  };
}

function normalizeBitacoraRecord(docSnap) {
  const raw = {
    id: docSnap.id,
    ...(docSnap.data() || {}),
  };

  const normalized = normalizeTimestamps(raw);

  return {
    id: normalized.id,
    mode: normalizeStoredMode(normalized.mode),
    title: safeString(normalized.title || normalized.titulo),
    content: safeString(normalized.content || normalized.contenido),
    fechaClase: safeString(normalized.fechaClase || normalized.fecha),
    studentIds: uniqueStrings(normalized.studentIds),
    studentRefs: uniqueStudentRefs(normalized.studentRefs),
    studentOverrides: normalizeStudentOverridesFromPayload(
      normalized,
      uniqueStrings(normalized.studentIds)
    ),
    primaryStudentId: safeString(normalized.primaryStudentId),
    author: normalizeAuthor(normalized.author),
    process: normalizeProcess(normalized.process),
    tags: normalizeTags(normalized.tags),
    attachments: normalizeAttachments(
      normalized.attachments || normalized.archivos
    ),
    status: safeString(normalized.status || "active"),
    source: safeString(normalized.source || "app"),
    metadata: isPlainObject(normalized.metadata) ? normalized.metadata : {},
    createdAt: normalized.createdAt || null,
    updatedAt: normalized.updatedAt || null,
  };
}

function sortBitacoras(items = []) {
  return [...items].sort((a, b) => {
    const dateA = Date.parse(a.fechaClase || a.updatedAt || a.createdAt || 0) || 0;
    const dateB = Date.parse(b.fechaClase || b.updatedAt || b.createdAt || 0) || 0;
    return dateB - dateA;
  });
}

function applyClientFilters(items = [], options = {}) {
  const mode = safeString(options.mode).toLowerCase();
  const search = safeString(options.search || options.query).toLowerCase();
  const status = safeString(options.status).toLowerCase();
  const processKey = safeString(options.processKey || options.processRef);

  let results = [...items];

  if (mode) {
    results = results.filter((item) => item.mode === mode);
  }

  if (status) {
    results = results.filter(
      (item) => safeString(item.status).toLowerCase() === status
    );
  }

  if (processKey) {
    results = results.filter(
      (item) => safeString(item?.process?.processKey) === processKey
    );
  }

  if (search) {
    results = results.filter((item) => {
      const haystack = [
        item.title,
        item.content,
        item.fechaClase,
        item.author?.name,
        item.author?.email,
        item.process?.area,
        item.process?.modalidad,
        item.process?.docente,
        item.process?.programa,
        ...(item.tags || []),
        ...(item.studentRefs || []).map((student) => student.name),
        ...(item.studentIds || []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(search);
    });
  }

  const max = Number(options.limit || DEFAULT_LIMIT);
  return sortBitacoras(results).slice(0, max > 0 ? max : DEFAULT_LIMIT);
}

async function runQueryWithOrderFallback(bitacorasRef, max) {
  try {
    const orderedQuery = query(
      bitacorasRef,
      orderBy("createdAt", "desc"),
      limit(max > 0 ? max : DEFAULT_LIMIT)
    );

    return await getDocs(orderedQuery);
  } catch (error) {
    console.warn(
      "Falló orderBy(createdAt) en bitácoras. Se usa fallback sin orden server-side.",
      error
    );

    const fallbackQuery = query(
      bitacorasRef,
      limit(max > 0 ? max : DEFAULT_LIMIT)
    );

    return await getDocs(fallbackQuery);
  }
}

/**
 * Lista bitácoras.
 * Ojo: Firestore no hace búsqueda full-text aquí.
 * Por eso se trae una tanda reciente y luego se filtra en cliente.
 */
export async function getBitacoras(options = {}) {
  assertFirestoreEnabled();
  assertAuthenticated();

  const max = Number(options.limit || DEFAULT_LIMIT);
  const bitacorasRef = collection(db, BITACORAS_COLLECTION);

  const snapshot = await runQueryWithOrderFallback(bitacorasRef, max);
  const items = snapshot.docs.map(normalizeBitacoraRecord);

  return applyClientFilters(items, options);
}

/**
 * Trae bitácoras de un estudiante usando array-contains.
 * Luego ordena y filtra en cliente para no depender de índices compuestos
 * desde el día uno, porque suficiente caos hay ya.
 */
export async function getBitacorasByStudent(studentId, options = {}) {
  assertFirestoreEnabled();
  assertAuthenticated();

  const safeStudentId = safeString(studentId);

  if (!safeStudentId) {
    throw createApiError("Se requiere studentId para consultar bitácoras.", {
      code: "MISSING_STUDENT_ID",
    });
  }

  const bitacorasRef = collection(db, BITACORAS_COLLECTION);

  const q = query(
    bitacorasRef,
    where("studentIds", "array-contains", safeStudentId)
  );

  const snapshot = await getDocs(q);
  const items = snapshot.docs.map(normalizeBitacoraRecord);

  return applyClientFilters(items, {
    ...options,
    limit: options.limit || CONFIG.limits.maxRecentBitacoras,
  });
}

/**
 * Consulta una bitácora puntual por id.
 */
export async function getBitacoraById(bitacoraId) {
  assertFirestoreEnabled();
  assertAuthenticated();

  const safeBitacoraId = safeString(bitacoraId);

  if (!safeBitacoraId) {
    throw createApiError("Se requiere bitacoraId para consultar la bitácora.", {
      code: "MISSING_BITACORA_ID",
    });
  }

  const ref = doc(db, BITACORAS_COLLECTION, safeBitacoraId);
  const snapshot = await getDoc(ref);

  if (!snapshot.exists()) {
    return null;
  }

  return normalizeBitacoraRecord(snapshot);
}

/**
 * Crea una bitácora nueva.
 */
export async function createBitacora(bitacoraData, options = {}) {
  assertFirestoreEnabled();
  const currentUser = assertAuthenticated();

  const payload = normalizeBitacoraPayload(
    {
      ...(isPlainObject(bitacoraData) ? bitacoraData : {}),
      author: currentUser,
    },
    options
  );
  const bitacorasRef = collection(db, BITACORAS_COLLECTION);

  const docRef = await addDoc(bitacorasRef, {
    ...payload,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  const created = await getBitacoraById(docRef.id);

  if (!created) {
    throw createApiError(
      "La bitácora se creó, pero no se pudo leer después del guardado.",
      {
        code: "BITACORA_CREATED_BUT_NOT_READABLE",
        bitacoraId: docRef.id,
      }
    );
  }

  return created;
}

/**
 * Actualiza una bitácora existente.
 */
export async function updateBitacora(bitacoraId, updates = {}, options = {}) {
  assertFirestoreEnabled();
  const currentUser = assertAuthenticated();

  const safeBitacoraId = safeString(bitacoraId);

  if (!safeBitacoraId) {
    throw createApiError("Se requiere bitacoraId para actualizar la bitácora.", {
      code: "MISSING_BITACORA_ID",
    });
  }

  const current = await getBitacoraById(safeBitacoraId);

  if (!current) {
    throw createApiError("No existe la bitácora que se intenta actualizar.", {
      code: "BITACORA_NOT_FOUND",
      bitacoraId: safeBitacoraId,
    });
  }

  const merged = {
    ...current,
    ...(isPlainObject(updates) ? updates : {}),
    id: current.id,
    createdAt: current.createdAt,
  };

  const normalized = normalizeBitacoraPayload(merged, options);

  const ref = doc(db, BITACORAS_COLLECTION, safeBitacoraId);

  await updateDoc(ref, {
    ...normalized,
    author: currentUser,
    updatedAt: serverTimestamp(),
  });

  const updated = await getBitacoraById(safeBitacoraId);

  if (!updated) {
    throw createApiError(
      "La bitácora se actualizó, pero no se pudo leer después del cambio.",
      {
        code: "BITACORA_UPDATED_BUT_NOT_READABLE",
        bitacoraId: safeBitacoraId,
      }
    );
  }

  return updated;
}

export default {
  getBitacoras,
  getBitacorasByStudent,
  getBitacoraById,
  createBitacora,
  updateBitacora,
};

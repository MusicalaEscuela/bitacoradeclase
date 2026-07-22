// js/api/planeador.api.js

/**
 * API del Planeador Docente.
 *
 * - CRUD de planeaciones (colección `planeaciones`).
 * - CRUD del tablero de post-its (colección `planeador_postits`).
 * - Puente con los catálogos existentes (`app_config/catalogos`) para que las
 *   subcategorías y ejercicios sugeridos sean los MISMOS de las bitácoras.
 */

import {
  db,
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  normalizeDoc,
  normalizeDocs,
  normalizeTimestamps,
} from "../firebase.client.js";

import {
  getPlaneacionesCollectionName,
  getPlaneadorPostitsCollectionName,
} from "../config.js";

import { getCatalogs, getEmptyCatalogs } from "./catalogs.api.js";
import {
  ARTES,
  createEmptyPlaneacion,
  createEmptyPostit,
} from "../utils/planeador.constants.js";
import { toStringSafe, toArraySafe } from "../utils/shared.js";

const PLANEACIONES = getPlaneacionesCollectionName();
const POSTITS = getPlaneadorPostitsCollectionName();

/* ==========================================================================
   PLANEACIONES
   ========================================================================== */

function normalizePlaneacion(record) {
  if (!record) return null;
  const normalized = normalizeTimestamps(record);
  // Garantiza que la forma siempre tenga todos los bloques (compatibilidad
  // hacia adelante si se agregan campos nuevos).
  return {
    ...createEmptyPlaneacion(),
    ...normalized,
    momentosClase: {
      ...createEmptyPlaneacion().momentosClase,
      ...(normalized.momentosClase || {}),
    },
    adaptaciones: {
      ...createEmptyPlaneacion().adaptaciones,
      ...(normalized.adaptaciones || {}),
    },
    evidenciaEsperada: {
      ...createEmptyPlaneacion().evidenciaEsperada,
      ...(normalized.evidenciaEsperada || {}),
    },
    reemplazo: {
      ...createEmptyPlaneacion().reemplazo,
      ...(normalized.reemplazo || {}),
    },
    habilidades: toArraySafe(normalized.habilidades),
    materiales: toArraySafe(normalized.materiales),
    categorias: toArraySafe(normalized.categorias),
    componenteCorporal: toArraySafe(normalized.componenteCorporal),
    componenteTecnico: toArraySafe(normalized.componenteTecnico),
    componenteTeorico: toArraySafe(normalized.componenteTeorico),
    componenteObras: toArraySafe(normalized.componenteObras),
    participantes: Array.isArray(normalized.participantes)
      ? normalized.participantes.map((item) => ({
          studentId: toStringSafe(item?.studentId || item?.id),
          nombre: toStringSafe(item?.nombre || item?.name),
          observacionEspecial: toStringSafe(item?.observacionEspecial),
        }))
      : [],
    comentariosCoordinacion: toArraySafe(normalized.comentariosCoordinacion),
    id: record.id,
  };
}

function buildSearchText(planeacion = {}) {
  return [
    planeacion.docenteNombre,
    planeacion.grupoNombre,
    ...toArraySafe(planeacion.participantes).map((item) => item?.nombre),
    planeacion.sede,
    planeacion.programa,
    planeacion.arte,
    planeacion.tipoClase,
    planeacion.objetivo,
    ...toArraySafe(planeacion.categorias),
    ...toArraySafe(planeacion.componenteCorporal),
    ...toArraySafe(planeacion.componenteTecnico),
    ...toArraySafe(planeacion.componenteTeorico),
    ...toArraySafe(planeacion.componenteObras),
  ]
    .map((v) => toStringSafe(v))
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * Lista planeaciones.
 * - `ownerEmail` presente (docente): solo sus documentos. La consulta lleva el
 *   `where` para que las reglas de Firestore la permitan.
 * - `ownerEmail` vacío (admin): todas.
 */
export async function listPlaneaciones(ownerEmail = "") {
  const ref = collection(db, PLANEACIONES);
  const owner = toStringSafe(ownerEmail).toLowerCase();
  let snapshot;

  if (owner) {
    // Sin orderBy para no exigir índice compuesto; se ordena en cliente.
    snapshot = await getDocs(query(ref, where("ownerEmail", "==", owner)));
  } else {
    try {
      snapshot = await getDocs(query(ref, orderBy("updatedAt", "desc")));
    } catch {
      snapshot = await getDocs(ref);
    }
  }

  return normalizeDocs(snapshot)
    .map(normalizePlaneacion)
    .filter(Boolean)
    .sort((a, b) => toStringSafe(b.updatedAt).localeCompare(toStringSafe(a.updatedAt)));
}

export async function getPlaneacion(id) {
  const safeId = toStringSafe(id);
  if (!safeId) return null;
  const snapshot = await getDoc(doc(db, PLANEACIONES, safeId));
  return normalizePlaneacion(normalizeDoc(snapshot));
}

export async function createPlaneacion(data = {}) {
  const payload = {
    ...createEmptyPlaneacion(data),
    searchText: buildSearchText(data),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  delete payload.id;
  const ref = await addDoc(collection(db, PLANEACIONES), payload);
  return ref.id;
}

export async function updatePlaneacion(id, data = {}) {
  const safeId = toStringSafe(id);
  if (!safeId) throw new Error("Falta el id de la planeación.");
  const { id: _ignored, createdAt, ...rest } = data;
  const payload = {
    ...rest,
    searchText: buildSearchText(data),
    updatedAt: serverTimestamp(),
  };
  await updateDoc(doc(db, PLANEACIONES, safeId), payload);
  return safeId;
}

/** Duplica una planeación existente como nuevo borrador. */
export async function duplicatePlaneacion(id) {
  const original = await getPlaneacion(id);
  if (!original) throw new Error("No se encontró la planeación a duplicar.");

  const { id: _omit, createdAt, updatedAt, ...rest } = original;
  return createPlaneacion({
    ...rest,
    estado: "borrador",
    compartida: false,
    fechaCompartida: "",
    comentariosCoordinacion: [],
    archived: false,
    objetivo: rest.objetivo,
  });
}

export async function deletePlaneacion(id) {
  const safeId = toStringSafe(id);
  if (!safeId) return false;
  await deleteDoc(doc(db, PLANEACIONES, safeId));
  return true;
}

/** Agrega un comentario interno de coordinación al arreglo del documento. */
export async function addComentarioCoordinacion(id, comentario = {}) {
  const planeacion = await getPlaneacion(id);
  if (!planeacion) throw new Error("No se encontró la planeación.");

  const nuevo = {
    id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    autor: toStringSafe(comentario.autor),
    texto: toStringSafe(comentario.texto),
    fecha: new Date().toISOString(),
  };

  const comentarios = [...toArraySafe(planeacion.comentariosCoordinacion), nuevo];
  await updateDoc(doc(db, PLANEACIONES, toStringSafe(id)), {
    comentariosCoordinacion: comentarios,
    updatedAt: serverTimestamp(),
  });
  return nuevo;
}

/* ==========================================================================
   POST-ITS (tablero)
   ========================================================================== */

function normalizePostit(record) {
  if (!record) return null;
  const normalized = normalizeTimestamps(record);
  return { ...createEmptyPostit(), ...normalized, id: record.id };
}

export async function listPostits(ownerEmail = "") {
  const ref = collection(db, POSTITS);
  const owner = toStringSafe(ownerEmail).toLowerCase();
  let snapshot;

  if (owner) {
    snapshot = await getDocs(query(ref, where("ownerEmail", "==", owner)));
  } else {
    try {
      snapshot = await getDocs(query(ref, orderBy("updatedAt", "desc")));
    } catch {
      snapshot = await getDocs(ref);
    }
  }

  return normalizeDocs(snapshot)
    .map(normalizePostit)
    .filter(Boolean)
    .sort((a, b) => toStringSafe(b.updatedAt).localeCompare(toStringSafe(a.updatedAt)));
}

export async function createPostit(data = {}) {
  const payload = {
    ...createEmptyPostit(data),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  delete payload.id;
  const ref = await addDoc(collection(db, POSTITS), payload);
  return ref.id;
}

export async function updatePostit(id, data = {}) {
  const safeId = toStringSafe(id);
  if (!safeId) throw new Error("Falta el id del post-it.");
  const { id: _ignored, createdAt, ...rest } = data;
  await updateDoc(doc(db, POSTITS, safeId), {
    ...rest,
    updatedAt: serverTimestamp(),
  });
  return safeId;
}

export async function deletePostit(id) {
  const safeId = toStringSafe(id);
  if (!safeId) return false;
  await deleteDoc(doc(db, POSTITS, safeId));
  return true;
}

/* ==========================================================================
   PUENTE CON CATÁLOGOS EXISTENTES
   Reutiliza `app_config/catalogos` (lo de las bitácoras) para sugerir
   subcategorías y ejercicios según el componente seleccionado.
   ========================================================================== */

let cachedCatalogs = null;

export async function loadCatalogsForPlaneador() {
  try {
    cachedCatalogs = await getCatalogs();
  } catch {
    cachedCatalogs = getEmptyCatalogs();
  }
  return cachedCatalogs;
}

function getAreaForArte(arteValue) {
  const found = ARTES.find((c) => c.value === arteValue);
  return found ? found.area : "";
}

// Resuelve la lista de un campo (componenteCorporal, categorias, etc.) por
// área, replicando la lógica del editor de bitácoras: primero la matriz por
// arte del campo, luego el catálogo general del campo (todas las áreas).
function catalogListForArea(catalogs, fieldPorArte, generalField, area) {
  if (!catalogs) return [];
  const grouped = catalogs[fieldPorArte] || {};
  if (area && Array.isArray(grouped[area]) && grouped[area].length) {
    // Une lo del área con los ítems generales aún no asignados a ningún arte
    // (para no "esconder" ejercicios nuevos), igual que el editor.
    const assigned = new Set();
    Object.values(grouped).forEach((vals) =>
      Array.isArray(vals) ? vals.forEach((v) => assigned.add(String(v).toLowerCase())) : null
    );
    const general = Array.isArray(catalogs[generalField]) ? catalogs[generalField] : [];
    const huerfanos = general.filter((v) => !assigned.has(String(v).toLowerCase()));
    return [...new Set([...grouped[area], ...huerfanos])];
  }
  return Array.isArray(catalogs[generalField]) ? catalogs[generalField] : [];
}

/**
 * Devuelve las listas del catálogo para un área artística, con el MISMO
 * lenguaje de las bitácoras:
 *   { categorias, componenteCorporal, componenteTecnico, componenteTeorico,
 *     componenteObras, fromCatalog }
 *
 * Usa el catálogo cacheado; llamar antes a loadCatalogsForPlaneador().
 */
export function buildAreaCatalog(arteValue) {
  const area = getAreaForArte(arteValue);
  const catalogs = cachedCatalogs;
  if (!catalogs) {
    return {
      categorias: [],
      componenteCorporal: [],
      componenteTecnico: [],
      componenteTeorico: [],
      componenteObras: [],
      fromCatalog: false,
      area,
    };
  }

  const lists = {
    categorias: catalogListForArea(catalogs, "categoriasPorArte", "categorias", area),
    componenteCorporal: catalogListForArea(catalogs, "componenteCorporalPorArte", "componenteCorporal", area),
    componenteTecnico: catalogListForArea(catalogs, "componenteTecnicoPorArte", "componenteTecnico", area),
    componenteTeorico: catalogListForArea(catalogs, "componenteTeoricoPorArte", "componenteTeorico", area),
    componenteObras: catalogListForArea(catalogs, "componenteObrasPorArte", "componenteObras", area),
  };

  const fromCatalog = Object.values(lists).some((l) => Array.isArray(l) && l.length);
  return { ...lists, fromCatalog, area };
}

/** Lista de docentes desde el catálogo (para el selector de docente). */
export function getCatalogTeachers() {
  return cachedCatalogs && Array.isArray(cachedCatalogs.docentes)
    ? cachedCatalogs.docentes
    : [];
}

export default {
  listPlaneaciones,
  getPlaneacion,
  createPlaneacion,
  updatePlaneacion,
  duplicatePlaneacion,
  deletePlaneacion,
  addComentarioCoordinacion,
  listPostits,
  createPostit,
  updatePostit,
  deletePostit,
  loadCatalogsForPlaneador,
  buildAreaCatalog,
  getCatalogTeachers,
};

import {
  getAppConfigCollectionName,
  getCatalogsDocumentId,
} from "../config.js";

import {
  db,
  doc,
  getDoc,
  normalizeTimestamps,
  serverTimestamp,
  setDoc,
} from "../firebase.client.js";

import {
  isPlainObject,
  toArraySafe,
  toStringSafe,
} from "../utils/shared.js";
import { syncTeacherAccessUsers } from "./users.api.js";

const APP_CONFIG_COLLECTION = getAppConfigCollectionName();
const CATALOGS_DOCUMENT_ID = getCatalogsDocumentId();
const ART_AREA_ALIASES = Object.freeze({
  musica: "musica",
  música: "musica",
  danza: "danza",
  artesplasticas: "artesPlasticas",
  "artes plasticas": "artesPlasticas",
  "artes plásticas": "artesPlasticas",
  artesPlasticas: "artesPlasticas",
  teatro: "teatro",
});

function createCatalogsError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

function uniqueByString(values = []) {
  return [...new Set(toArraySafe(values).map((item) => toStringSafe(item)).filter(Boolean))];
}

function normalizeCatalogStringList(values = []) {
  return uniqueByString(values).sort((a, b) =>
    a.localeCompare(b, "es", { sensitivity: "base" })
  );
}

// Componentes que admiten una categoria automatica por item. (Las "categorias"
// no se mapean a si mismas.)
const AUTO_CATEGORY_COMPONENTS = Object.freeze([
  "componenteCorporal",
  "componenteTecnico",
  "componenteTeorico",
  "componenteObras",
]);

// Mapa { componenteX: { "<item>": "<categoria>" } } que define que categoria se
// agrega automaticamente al seleccionar un item de ese componente en el editor.
function normalizeAutoCategorias(value = {}) {
  if (!isPlainObject(value)) return {};

  return AUTO_CATEGORY_COMPONENTS.reduce((next, key) => {
    const group = value[key];
    if (!isPlainObject(group)) return next;

    const mapping = Object.entries(group).reduce((acc, [item, category]) => {
      const safeItem = toStringSafe(item);
      const safeCategory = toStringSafe(category);
      if (safeItem && safeCategory) acc[safeItem] = safeCategory;
      return acc;
    }, {});

    if (Object.keys(mapping).length) next[key] = mapping;
    return next;
  }, {});
}

function normalizeCatalogGroups(groups = {}) {
  if (!isPlainObject(groups)) return {};

  return Object.entries(groups).reduce((next, [key, values]) => {
    const safeKey = normalizeArtAreaKey(key);
    if (!safeKey) return next;
    next[safeKey] = normalizeCatalogStringList([
      ...(Array.isArray(next[safeKey]) ? next[safeKey] : []),
      ...toArraySafe(values),
    ]);
    return next;
  }, {});
}

function normalizeArtAreaKey(value) {
  const safeValue = toStringSafe(value);
  if (!safeValue) return "";
  const compact = safeValue
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
  return ART_AREA_ALIASES[safeValue] || ART_AREA_ALIASES[compact] || safeValue;
}

function normalizeTeacher(item = {}, index = 0) {
  if (!isPlainObject(item)) return null;

  const id =
    toStringSafe(item.id) ||
    toStringSafe(item.teacherKey) ||
    `teacher_${index + 1}`;

  const nombre = toStringSafe(item.nombre || item.name);
  if (!nombre) return null;

  const orden = Number(item.orden);

  return {
    id,
    nombre,
    alias: toStringSafe(item.alias),
    email: toStringSafe(item.email),
    activo:
      item.activo === undefined || item.activo === null
        ? true
        : Boolean(item.activo),
    orden: Number.isFinite(orden) ? orden : index + 1,
  };
}

function normalizeTeachers(values = []) {
  const seen = new Set();

  return toArraySafe(values)
    .map((item, index) => normalizeTeacher(item, index))
    .filter((item) => item && item.activo)
    .filter((item) => {
      const key = `${item.nombre.toLowerCase()}__${item.alias.toLowerCase()}__${item.email.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const orderDiff = (a.orden || 999999) - (b.orden || 999999);
      if (orderDiff !== 0) return orderDiff;
      return a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" });
    });
}

function normalizeCatalogsDocument(data = {}) {
  const normalized = normalizeTimestamps(isPlainObject(data) ? data : {});
  const docentes = normalizeTeachers(normalized.docentes);

  return {
    docentes,
    teacherAccessEmails: uniqueByString(
      docentes.map((teacher) => toStringSafe(teacher.email).toLowerCase())
    ),
    categorias: normalizeCatalogStringList(normalized.categorias),
    componenteCorporal: normalizeCatalogStringList(normalized.componenteCorporal),
    componenteTecnico: normalizeCatalogStringList(normalized.componenteTecnico),
    componenteTeorico: normalizeCatalogStringList(normalized.componenteTeorico),
    componenteObras: normalizeCatalogStringList(normalized.componenteObras),
    porArte: normalizeCatalogGroups(normalized.porArte || normalized.catalogosPorArte),
    categoriasPorArte: normalizeCatalogGroups(normalized.categoriasPorArte),
    componenteCorporalPorArte: normalizeCatalogGroups(normalized.componenteCorporalPorArte),
    componenteTecnicoPorArte: normalizeCatalogGroups(normalized.componenteTecnicoPorArte),
    componenteTeoricoPorArte: normalizeCatalogGroups(normalized.componenteTeoricoPorArte),
    componenteObrasPorArte: normalizeCatalogGroups(normalized.componenteObrasPorArte),
    autoCategorias: normalizeAutoCategorias(normalized.autoCategorias),
    updatedAt: normalized.updatedAt || null,
  };
}

export function getEmptyCatalogs() {
  return normalizeCatalogsDocument({});
}

export async function getCatalogs() {
  const ref = doc(db, APP_CONFIG_COLLECTION, CATALOGS_DOCUMENT_ID);
  const snapshot = await getDoc(ref);

  if (!snapshot.exists()) {
    throw createCatalogsError(
      `No existe el documento ${APP_CONFIG_COLLECTION}/${CATALOGS_DOCUMENT_ID} en Firestore.`,
      {
        code: "CATALOGS_NOT_FOUND",
      }
    );
  }

  return normalizeCatalogsDocument(snapshot.data());
}

export async function saveCatalogs(input = {}) {
  const normalized = normalizeCatalogsDocument(input);
  const ref = doc(db, APP_CONFIG_COLLECTION, CATALOGS_DOCUMENT_ID);

  await setDoc(
    ref,
    {
      ...normalized,
      updatedAt: serverTimestamp(),
    }
  );

  await syncTeacherAccessUsers(normalized.docentes);

  return normalized;
}

export {
  normalizeCatalogsDocument,
  normalizeCatalogStringList,
  normalizeTeachers,
};

export default {
  getCatalogs,
  getEmptyCatalogs,
  saveCatalogs,
};

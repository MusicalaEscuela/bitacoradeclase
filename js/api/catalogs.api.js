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

const APP_CONFIG_COLLECTION = getAppConfigCollectionName();
const CATALOGS_DOCUMENT_ID = getCatalogsDocumentId();

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

  return {
    docentes: normalizeTeachers(normalized.docentes),
    categorias: normalizeCatalogStringList(normalized.categorias),
    componenteCorporal: normalizeCatalogStringList(normalized.componenteCorporal),
    componenteTecnico: normalizeCatalogStringList(normalized.componenteTecnico),
    componenteTeorico: normalizeCatalogStringList(normalized.componenteTeorico),
    componenteObras: normalizeCatalogStringList(normalized.componenteObras),
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
    },
    { merge: true }
  );

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

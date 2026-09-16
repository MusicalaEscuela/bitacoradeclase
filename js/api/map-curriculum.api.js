import {
  getApps,
  initializeApp,
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import {
  doc,
  getDoc,
  getFirestore,
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";
import {
  adaptPublishedPianoCurriculum,
  adaptPublishedGuitarCurriculum,
  adaptPublishedViolinCurriculum,
  MAP_PIANO_CURRICULUM_COLLECTION,
  MAP_PIANO_CURRICULUM_DOCUMENT,
} from "../utils/map-piano-route.js";

const MAP_FIREBASE_APP_NAME = "mapa-de-experiencias-curriculum";
const MAP_FIREBASE_CONFIG = Object.freeze({
  apiKey: "AIzaSyACJ_tXf8znOlNC2bT3OlxTlpm-i2FkOl8",
  authDomain: "mapa-de-experiencias.firebaseapp.com",
  projectId: "mapa-de-experiencias",
  storageBucket: "mapa-de-experiencias.firebasestorage.app",
  messagingSenderId: "131491272175",
  appId: "1:131491272175:web:4b4a3d1efa8b3b0695121a",
});

const mapApp =
  getApps().find((candidate) => candidate.name === MAP_FIREBASE_APP_NAME) ||
  initializeApp(MAP_FIREBASE_CONFIG, MAP_FIREBASE_APP_NAME);
const mapDb = getFirestore(mapApp);

let pianoCurriculumPromise = null;
let guitarCurriculumPromise = null;
let violinCurriculumPromise = null;

function createCurriculumError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

export async function getPublishedPianoCurriculum(options = {}) {
  const forceReload = options?.forceReload === true;
  if (pianoCurriculumPromise && !forceReload) {
    return pianoCurriculumPromise;
  }

  pianoCurriculumPromise = (async () => {
    const snapshot = await getDoc(
      doc(
        mapDb,
        MAP_PIANO_CURRICULUM_COLLECTION,
        MAP_PIANO_CURRICULUM_DOCUMENT
      )
    );
    if (!snapshot.exists()) {
      throw createCurriculumError(
        "La ruta publicada de Piano no está disponible en Mapa de Experiencias.",
        { code: "MAP_PIANO_CURRICULUM_NOT_FOUND" }
      );
    }
    return adaptPublishedPianoCurriculum(snapshot.data());
  })();

  try {
    return await pianoCurriculumPromise;
  } catch (error) {
    pianoCurriculumPromise = null;
    throw error;
  }
}

export async function getPublishedGuitarCurriculum(options = {}) {
  const forceReload = options?.forceReload === true;
  if (guitarCurriculumPromise && !forceReload) return guitarCurriculumPromise;

  guitarCurriculumPromise = (async () => {
    const snapshot = await getDoc(doc(mapDb, MAP_PIANO_CURRICULUM_COLLECTION, "guitarra"));
    if (!snapshot.exists()) {
      throw createCurriculumError("La ruta publicada de Guitarra no está disponible en Mapa de Experiencias.", { code: "MAP_GUITAR_CURRICULUM_NOT_FOUND" });
    }
    return adaptPublishedGuitarCurriculum(snapshot.data());
  })();
  try {
    return await guitarCurriculumPromise;
  } catch (error) {
    guitarCurriculumPromise = null;
    throw error;
  }
}

export async function getPublishedViolinCurriculum(options = {}) {
  const forceReload = options?.forceReload === true;
  if (violinCurriculumPromise && !forceReload) return violinCurriculumPromise;

  violinCurriculumPromise = (async () => {
    const snapshot = await getDoc(doc(mapDb, MAP_PIANO_CURRICULUM_COLLECTION, "violin"));
    if (!snapshot.exists()) {
      throw createCurriculumError("La ruta publicada de Violín no está disponible en Mapa de Experiencias.", { code: "MAP_VIOLIN_CURRICULUM_NOT_FOUND" });
    }
    return adaptPublishedViolinCurriculum(snapshot.data());
  })();
  try {
    return await violinCurriculumPromise;
  } catch (error) {
    violinCurriculumPromise = null;
    throw error;
  }
}

export function clearPublishedPianoCurriculumCache() {
  pianoCurriculumPromise = null;
}

export function clearPublishedGuitarCurriculumCache() { guitarCurriculumPromise = null; }
export function clearPublishedViolinCurriculumCache() { violinCurriculumPromise = null; }

export default {
  getPublishedPianoCurriculum,
  getPublishedGuitarCurriculum,
  getPublishedViolinCurriculum,
  clearPublishedPianoCurriculumCache,
  clearPublishedGuitarCurriculumCache,
  clearPublishedViolinCurriculumCache,
};

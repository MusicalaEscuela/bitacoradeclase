// js/firebase.client.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";

import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js";

import {
  getFirestore,
  collection,
  collectionGroup,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  serverTimestamp,
  Timestamp,
  writeBatch,
  documentId,
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";

import {
  getStorage,
  ref,
  uploadBytes,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-storage.js";

/* ==========================================================================
   CONFIG
   ========================================================================== */

const firebaseConfig = {
  apiKey: "AIzaSyDQcHQEzGE1DDpD1b_foUTmVo3D9LK_0N0",
  authDomain: "bitacoras-de-clase.firebaseapp.com",
  projectId: "bitacoras-de-clase",
  storageBucket: "bitacoras-de-clase.firebasestorage.app",
  messagingSenderId: "1047385643159",
  appId: "1:1047385643159:web:074d75890a648f6ac5f1d2",
};

/* ==========================================================================
   APP
   ========================================================================== */

const app = initializeApp(firebaseConfig);

/* ==========================================================================
   AUTH
   ========================================================================== */

const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

googleProvider.setCustomParameters({
  prompt: "select_account",
});

/* ==========================================================================
   FIRESTORE
   ========================================================================== */

const db = getFirestore(app);

/* ==========================================================================
   STORAGE
   ========================================================================== */

const storage = getStorage(app);

/* ==========================================================================
   HELPERS
   ========================================================================== */

/**
 * Convierte un user de Firebase Auth a un objeto limpio y consistente
 */
function normalizeAuthUser(user) {
  if (!user) return null;

  return {
    uid: user.uid || "",
    name: user.displayName || "",
    email: user.email || "",
    photoURL: user.photoURL || "",
    isAnonymous: !!user.isAnonymous,
  };
}

/**
 * Convierte un DocumentSnapshot a objeto plano
 */
function normalizeDoc(docSnap) {
  if (!docSnap?.exists()) return null;

  const data = docSnap.data() || {};

  return {
    id: docSnap.id,
    ...data,
  };
}

/**
 * Convierte un QuerySnapshot a array plano
 */
function normalizeDocs(snapshot) {
  if (!snapshot?.docs?.length) return [];
  return snapshot.docs.map((docSnap) => normalizeDoc(docSnap)).filter(Boolean);
}

/**
 * Convierte cualquier fecha de Firebase a ISO si aplica
 */
function toISO(value) {
  if (!value) return null;

  if (typeof value?.toDate === "function") {
    return value.toDate().toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}

/**
 * Convierte campos de fecha comunes a ISO
 */
function normalizeTimestamps(item = {}) {
  const clone = { ...item };

  const timestampFields = [
    "createdAt",
    "updatedAt",
    "fecha",
    "fechaClase",
    "lastEditedAt",
    "uploadedAt",
  ];

  for (const field of timestampFields) {
    if (field in clone) {
      clone[field] = toISO(clone[field]);
    }
  }

  return clone;
}

/* ==========================================================================
   AUTH METHODS
   ========================================================================== */

/**
 * Login con Google
 */
async function loginWithGoogle() {
  const result = await signInWithPopup(auth, googleProvider);
  return normalizeAuthUser(result.user);
}

/**
 * Logout
 */
async function logoutUser() {
  await signOut(auth);
  return true;
}

/**
 * Escucha cambios de sesión
 */
function observeAuth(callback) {
  return onAuthStateChanged(auth, (user) => {
    callback(normalizeAuthUser(user));
  });
}

/**
 * Usuario actual limpio
 */
function getCurrentUser() {
  return normalizeAuthUser(auth.currentUser);
}

/* ==========================================================================
   FIRESTORE HELPERS
   ========================================================================== */

/**
 * Obtiene referencia a colección
 */
function col(path) {
  return collection(db, path);
}

/**
 * Obtiene referencia a documento
 */
function docRef(path, id) {
  return doc(db, path, id);
}

/**
 * Lee un documento por path/id
 */
async function getOne(path, id) {
  const snapshot = await getDoc(doc(db, path, id));
  return normalizeTimestamps(normalizeDoc(snapshot));
}

/**
 * Crea documento con ID automático
 */
async function createOne(path, data = {}) {
  const payload = {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  const refDoc = await addDoc(collection(db, path), payload);
  return refDoc.id;
}

/**
 * Crea o reemplaza documento con ID definido
 */
async function setOne(path, id, data = {}, options = { merge: true }) {
  const payload = {
    ...data,
    updatedAt: serverTimestamp(),
  };

  if (!data.createdAt) {
    payload.createdAt = serverTimestamp();
  }

  await setDoc(doc(db, path, id), payload, options);
  return id;
}

/**
 * Actualiza parcialmente un documento
 */
async function updateOne(path, id, data = {}) {
  const payload = {
    ...data,
    updatedAt: serverTimestamp(),
  };

  await updateDoc(doc(db, path, id), payload);
  return id;
}

/**
 * Elimina un documento
 */
async function removeOne(path, id) {
  await deleteDoc(doc(db, path, id));
  return true;
}

/**
 * Lista documentos simples de una colección
 */
async function listAll(path) {
  const snapshot = await getDocs(collection(db, path));
  return normalizeDocs(snapshot).map(normalizeTimestamps);
}

/* ==========================================================================
   STORAGE HELPERS
   ========================================================================== */

/**
 * Sube archivo simple
 */
async function uploadFile(path, file) {
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, file);
  const url = await getDownloadURL(storageRef);

  return {
    path,
    name: file?.name || "",
    type: file?.type || "",
    size: file?.size || 0,
    url,
  };
}

/**
 * Sube archivo con progreso
 */
function uploadFileResumable(path, file, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const storageRef = ref(storage, path);
    const task = uploadBytesResumable(storageRef, file);

    task.on(
      "state_changed",
      (snapshot) => {
        const progress = snapshot.totalBytes
          ? Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100)
          : 0;

        onProgress(progress, snapshot);
      },
      (error) => reject(error),
      async () => {
        const url = await getDownloadURL(task.snapshot.ref);

        resolve({
          path,
          name: file?.name || "",
          type: file?.type || "",
          size: file?.size || 0,
          url,
        });
      }
    );
  });
}

/**
 * Elimina archivo de Storage
 */
async function removeFile(path) {
  const storageRef = ref(storage, path);
  await deleteObject(storageRef);
  return true;
}

/* ==========================================================================
   EXPORTS
   ========================================================================== */

export {
  // core
  app,
  auth,
  db,
  storage,

  // auth helpers
  googleProvider,
  loginWithGoogle,
  logoutUser,
  observeAuth,
  getCurrentUser,
  normalizeAuthUser,

  // firestore sdk exports
  collection,
  collectionGroup,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  serverTimestamp,
  Timestamp,
  writeBatch,
  documentId,

  // firestore helpers
  col,
  docRef,
  getOne,
  createOne,
  setOne,
  updateOne,
  removeOne,
  listAll,
  normalizeDoc,
  normalizeDocs,
  normalizeTimestamps,
  toISO,

  // storage sdk exports
  ref,
  uploadBytes,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,

  // storage helpers
  uploadFile,
  uploadFileResumable,
  removeFile,
};
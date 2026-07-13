import {
  app,
  collection,
  db,
  getDocs,
  normalizeTimestamps,
} from "../firebase.client.js";
import { toStringSafe } from "../utils/shared.js";
import {
  getFunctions,
  httpsCallable,
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-functions.js";

const LINKS_COLLECTION = "student_identity_links";
const REVIEWS_COLLECTION = "student_identity_link_reviews";
let cachedRecords = [];
const functions = getFunctions(app, "us-central1");

function normalizeRecord(docSnap, kind) {
  return {
    id: docSnap.id,
    kind,
    ...normalizeTimestamps(docSnap.data() || {}),
  };
}

export async function listStudentIdentityLinkRecords(options = {}) {
  const includeReviews = options.includeReviews === true;
  const snapshots = await Promise.all([
    getDocs(collection(db, LINKS_COLLECTION)),
    ...(includeReviews
      ? [getDocs(collection(db, REVIEWS_COLLECTION))]
      : []),
  ]);
  const records = [
    ...snapshots[0].docs.map((docSnap) => normalizeRecord(docSnap, "link")),
    ...(snapshots[1]?.docs || []).map((docSnap) => normalizeRecord(docSnap, "review")),
  ];
  cachedRecords = records;
  return records;
}

export function getCachedStudentIdentityLinkRecords() {
  return [...cachedRecords];
}

export async function manageStudentIdentityLink(payload = {}) {
  const callable = httpsCallable(functions, "manageStudentIdentityLink");
  const result = await callable({
    action: toStringSafe(payload.action || "confirm"),
    canonicalStudentId: toStringSafe(payload.canonicalStudentId),
    academicRecordId: toStringSafe(payload.academicRecordId),
    linkedStudentIds: Array.isArray(payload.linkedStudentIds)
      ? payload.linkedStudentIds.map(toStringSafe).filter(Boolean)
      : [],
  });
  return result?.data || {};
}

export function maskStudentIdentityId(value) {
  const id = toStringSafe(value);
  if (!id) return "—";
  if (/^stu_/i.test(id)) return `stu_…_${id.slice(-3)}`;
  if (id.length <= 4) return `${id.slice(0, 1)}…${id.slice(-1)}`;
  return `${id.slice(0, 2)}…${id.slice(-2)}`;
}

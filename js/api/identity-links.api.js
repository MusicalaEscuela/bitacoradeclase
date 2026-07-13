import {
  collection,
  db,
  doc,
  getCurrentUser,
  getDocs,
  normalizeTimestamps,
  serverTimestamp,
  writeBatch,
} from "../firebase.client.js";
import { toStringSafe } from "../utils/shared.js";

const LINKS_COLLECTION = "student_identity_links";
const REVIEWS_COLLECTION = "student_identity_link_reviews";
let cachedRecords = [];

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
  const action = toStringSafe(payload.action || "confirm").toLowerCase();
  const canonicalStudentId = toStringSafe(payload.canonicalStudentId);
  const academicRecordId = toStringSafe(payload.academicRecordId);
  const currentUser = getCurrentUser();
  if (!currentUser?.uid) throw new Error("Debes iniciar sesión.");
  if (!canonicalStudentId || !academicRecordId || canonicalStudentId === academicRecordId) {
    throw new Error("Selecciona dos registros distintos.");
  }
  if (/^stu_/i.test(canonicalStudentId) || !/^stu_/i.test(academicRecordId)) {
    throw new Error("Selecciona un canónico y un expediente STU.");
  }

  const batch = writeBatch(db);
  const reviewKey = `${canonicalStudentId}__${academicRecordId}`;
  const reviewRef = doc(db, REVIEWS_COLLECTION, reviewKey);
  const now = serverTimestamp();

  if (action === "reject") {
    batch.set(reviewRef, {
      canonicalStudentId,
      academicRecordId,
      linkedStudentIds: [canonicalStudentId, academicRecordId],
      status: "rejected",
      linkMethod: "admin-rejected",
      reviewedAt: now,
      reviewedBy: currentUser.uid,
    });
    await batch.commit();
    return { ok: true, status: "rejected" };
  }

  const linkedStudentIds = [canonicalStudentId, academicRecordId];
  const linkRef = doc(db, LINKS_COLLECTION, canonicalStudentId);
  batch.set(linkRef, {
    canonicalStudentId,
    academicRecordId,
    linkedStudentIds,
    status: "confirmed",
    linkMethod: "admin-confirmed",
    linkedAt: now,
    linkedBy: currentUser.uid,
  });
  linkedStudentIds.forEach((studentId) => {
    batch.set(doc(db, "student_identity_link_members", studentId), {
      studentId,
      canonicalStudentId,
      status: "confirmed",
      linkedAt: now,
    });
  });
  batch.delete(reviewRef);
  await batch.commit();
  return { ok: true, status: "confirmed", linkedStudentIds };
}

export function maskStudentIdentityId(value) {
  const id = toStringSafe(value);
  if (!id) return "—";
  if (/^stu_/i.test(id)) return `stu_…_${id.slice(-3)}`;
  if (id.length <= 4) return `${id.slice(0, 1)}…${id.slice(-1)}`;
  return `${id.slice(0, 2)}…${id.slice(-2)}`;
}

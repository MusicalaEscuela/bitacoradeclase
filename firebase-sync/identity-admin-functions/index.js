"use strict";

const crypto = require("crypto");
const admin = require("firebase-admin");
const { HttpsError, onCall } = require("firebase-functions/v2/https");

admin.initializeApp();
const db = admin.firestore();

const STUDENTS = "students";
const USERS = "users";
const LINKS = "student_identity_links";
const MEMBERS = "student_identity_link_members";
const REVIEWS = "student_identity_link_reviews";
const ADMIN_ROLES = new Set([
  "admin",
  "administrator",
  "administrador",
  "administradora",
  "administrative",
  "administrativo",
  "administrativa",
  "direction",
  "direccion",
  "dirección",
]);

function safeId(value, field) {
  const text = String(value || "").trim();
  if (!text || text.length > 200 || text.includes("/")) {
    throw new HttpsError("invalid-argument", `${field} no es válido.`);
  }
  return text;
}

function uniqueIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) =>
    String(value || "").trim()
  ).filter(Boolean))];
}

function normalizeDocument(value) {
  return String(value || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function documentFingerprint(data = {}) {
  return normalizeDocument(
    data.documentFingerprint ||
      data.documento ||
      data.numeroDocumento ||
      data.identificacion ||
      data.cc
  );
}

function reviewId(canonicalStudentId, academicRecordId) {
  return crypto
    .createHash("sha256")
    .update(`${canonicalStudentId}\n${academicRecordId}`)
    .digest("hex");
}

async function requireAdmin(request) {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  }
  const email = String(request.auth.token?.email || "").trim().toLowerCase();
  if (!email) {
    throw new HttpsError("permission-denied", "La cuenta no tiene correo verificable.");
  }
  const profile = await db.collection(USERS).doc(email).get();
  const data = profile.data() || {};
  const role = String(data.role || data.rol || "").trim().toLowerCase();
  if (!profile.exists || data.active === false || !ADMIN_ROLES.has(role)) {
    throw new HttpsError("permission-denied", "Se requiere rol administrador activo.");
  }
  return { uid: request.auth.uid };
}

exports.manageStudentIdentityLink = onCall(
  { region: "us-central1", timeoutSeconds: 60, memory: "256MiB" },
  async (request) => {
    const actor = await requireAdmin(request);
    const action = String(request.data?.action || "confirm").trim().toLowerCase();
    if (!new Set(["confirm", "reject"]).has(action)) {
      throw new HttpsError("invalid-argument", "Acción no soportada.");
    }

    const canonicalStudentId = safeId(
      request.data?.canonicalStudentId,
      "canonicalStudentId"
    );
    const academicRecordId = safeId(
      request.data?.academicRecordId,
      "academicRecordId"
    );
    if (canonicalStudentId === academicRecordId) {
      throw new HttpsError("invalid-argument", "Los IDs deben ser distintos.");
    }
    if (/^stu_/i.test(canonicalStudentId) || !/^stu_/i.test(academicRecordId)) {
      throw new HttpsError(
        "invalid-argument",
        "Selecciona un canónico y un expediente histórico STU."
      );
    }

    const linkedStudentIds = uniqueIds([
      canonicalStudentId,
      academicRecordId,
      ...uniqueIds(request.data?.linkedStudentIds),
    ]);
    if (linkedStudentIds.length > 20) {
      throw new HttpsError("invalid-argument", "Demasiados aliases para un vínculo.");
    }

    const reviewRef = db.collection(REVIEWS).doc(
      reviewId(canonicalStudentId, academicRecordId)
    );

    const result = await db.runTransaction(async (transaction) => {
      const studentRefs = linkedStudentIds.map((id) => db.collection(STUDENTS).doc(id));
      const memberRefs = linkedStudentIds.map((id) => db.collection(MEMBERS).doc(id));
      const linkRef = db.collection(LINKS).doc(canonicalStudentId);
      const [studentSnaps, memberSnaps, currentLink] = await Promise.all([
        Promise.all(studentRefs.map((ref) => transaction.get(ref))),
        Promise.all(memberRefs.map((ref) => transaction.get(ref))),
        transaction.get(linkRef),
      ]);

      const missing = studentSnaps.filter((snap) => !snap.exists).map((snap) => snap.id);
      if (missing.length) {
        throw new HttpsError("not-found", "Uno o más estudiantes no existen.");
      }

      memberSnaps.forEach((snap) => {
        const owner = String(snap.data()?.canonicalStudentId || "");
        if (snap.exists && owner && owner !== canonicalStudentId) {
          throw new HttpsError(
            "failed-precondition",
            "Uno de los IDs ya pertenece a otro estudiante lógico."
          );
        }
      });

      if (
        currentLink.exists &&
        currentLink.data()?.status === "confirmed" &&
        currentLink.data()?.academicRecordId !== academicRecordId
      ) {
        throw new HttpsError(
          "already-exists",
          "El canónico ya tiene otro expediente confirmado."
        );
      }

      const canonicalData = studentSnaps[linkedStudentIds.indexOf(canonicalStudentId)].data() || {};
      const canonicalDocument = documentFingerprint(canonicalData);
      for (const snap of studentSnaps) {
        const otherDocument = documentFingerprint(snap.data() || {});
        if (canonicalDocument && otherDocument && canonicalDocument !== otherDocument) {
          throw new HttpsError(
            "failed-precondition",
            "Existe un conflicto documental fuerte entre los registros."
          );
        }
      }

      const now = admin.firestore.FieldValue.serverTimestamp();
      if (action === "reject") {
        transaction.set(reviewRef, {
          canonicalStudentId,
          academicRecordId,
          linkedStudentIds: [canonicalStudentId, academicRecordId],
          status: "rejected",
          linkMethod: "admin-rejected",
          reviewedAt: now,
          reviewedBy: actor.uid,
        });
        return { status: "rejected", canonicalStudentId, academicRecordId };
      }

      transaction.set(linkRef, {
        canonicalStudentId,
        academicRecordId,
        linkedStudentIds,
        status: "confirmed",
        linkMethod: "admin-confirmed",
        linkedAt: now,
        linkedBy: actor.uid,
      });
      memberRefs.forEach((ref, index) => {
        transaction.set(ref, {
          studentId: linkedStudentIds[index],
          canonicalStudentId,
          status: "confirmed",
          linkedAt: now,
        });
      });
      transaction.delete(reviewRef);
      return { status: "confirmed", canonicalStudentId, academicRecordId, linkedStudentIds };
    });

    return { ok: true, ...result };
  }
);

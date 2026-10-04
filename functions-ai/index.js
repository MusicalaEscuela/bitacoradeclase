"use strict";

/*
  Informe de proceso con IA — Bitácoras de clase y Estudiantes HUB.

  Gemini vía Vertex AI con la cuenta de servicio de la función: no hay API
  keys en el código ni en el navegador (el repo es público). La cuenta de
  servicio necesita el rol "Vertex AI User" en el proyecto bitacoras-de-clase.
*/

const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { GoogleGenAI } = require("@google/genai");
const report = require("./report");

initializeApp();
const db = getFirestore();

const AI_MODEL = defineString("AI_REPORT_MODEL", { default: "gemini-2.5-flash" });
const AI_LOCATION = defineString("AI_REPORT_LOCATION", { default: "us-central1" });

let genai = null;
function getGenAI() {
  if (!genai) {
    genai = new GoogleGenAI({
      vertexai: true,
      project: process.env.GCLOUD_PROJECT,
      location: AI_LOCATION.value(),
    });
  }
  return genai;
}

// Reserva un uso del día; devuelve una función para devolverlo si falla la IA.
async function reserveDailyUse(uid, kind) {
  const ref = db.collection("ai_report_usage").doc(report.usageDocId(uid));
  const limit = report.DAILY_LIMIT[kind];
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const count = snap.exists ? Number(snap.get("count") || 0) : 0;
    if (count >= limit) {
      throw new HttpsError(
        "resource-exhausted",
        `Ya se generaron ${limit} informes hoy desde esta cuenta. Intenta de nuevo mañana.`
      );
    }
    tx.set(ref, { uid, kind, count: count + 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
  return () => ref.update({ count: FieldValue.increment(-1) }).catch(() => {});
}

exports.generateStudentReport = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 120,
    maxInstances: 10,
  },
  async (request) => {
    const email = String(request.auth?.token?.email || "").toLowerCase();
    if (!request.auth || !email) {
      throw new HttpsError("unauthenticated", "Inicia sesión para generar el informe.");
    }

    const input = report.validateRequest(request.data);
    if (input.error) throw new HttpsError("invalid-argument", input.error);

    const profileSnap = await db.collection("users").doc(email).get();
    const access = report.resolveAccess(profileSnap.exists ? profileSnap.data() : null, input.studentIds);
    if (!access.allowed) throw new HttpsError("permission-denied", access.reason);

    const refund = await reserveDailyUse(request.auth.uid, access.kind);
    const model = AI_MODEL.value();

    try {
      const response = await getGenAI().models.generateContent({
        model,
        contents: report.buildUserPrompt(input),
        config: {
          systemInstruction: report.buildSystemInstruction(input.tone),
          temperature: 0.4,
          maxOutputTokens: 8192,
          thinkingConfig: { thinkingBudget: 0 },
        },
      });
      const markdown = report.cleanModelOutput(response.text);
      if (!markdown) throw new Error(`Respuesta vacía (${response.candidates?.[0]?.finishReason || "sin motivo"})`);

      logger.info("Informe IA generado", {
        studentId: access.studentId,
        kind: access.kind,
        tone: input.tone,
        dossierChars: input.dossier.length,
        usage: response.usageMetadata,
      });
      return { markdown, model };
    } catch (error) {
      await refund();
      if (error instanceof HttpsError) throw error;
      logger.error("Falló la generación del informe IA", { studentId: access.studentId, error: error.message });
      throw new HttpsError("unavailable", "La IA no pudo redactar el informe en este momento. Intenta de nuevo en unos minutos.");
    }
  }
);

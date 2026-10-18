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
const bitacoraImport = require("./import");
const repertoireSync = require("./repertoire-sync");

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
    timeoutSeconds: 180,
    maxInstances: 10,
  },
  async (request) => {
    if (request.data?.operation === "sync-bitacora-repertoire") {
      const email = String(request.auth?.token?.email || '').toLowerCase();
      if (!request.auth || !email) throw new HttpsError('unauthenticated','Inicia sesión.');
      const profile = await db.collection('users').doc(email).get();
      const role = profile.exists ? String(profile.data().role || '').toLowerCase() : '';
      const admin = ['admin','administrator','administrador','administradora','administrative','administrativo','administrativa','direction','direccion','dirección'].includes(role);
      if (!profile.exists || profile.data().active === false || (!admin && !['teacher','docente','profesor','profesora'].includes(role))) {
        throw new HttpsError('permission-denied','Solo el equipo activo puede sincronizar obras.');
      }
      const ids = request.data.bitacoraIds;
      const studentId = request.data.studentId || '';
      if (!Array.isArray(ids) || ids.length > 40 || !ids.length || ids.some(id=>typeof id!=='string'||!id||id.includes('/')) || typeof studentId!=='string'||studentId.includes('/')) {
        throw new HttpsError('invalid-argument','Selecciona hasta 40 bitácoras válidas.');
      }
      return repertoireSync.syncFromBitacoras(db,FieldValue,{bitacoraIds:[...new Set(ids)],studentId,isAdmin:admin});
    }
    if (request.data?.operation === "normalize-bitacoras") return prepareBitacoraImport(request);
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

// Solo prepara una vista previa. El guardado conserva el flujo y reglas actuales.
async function prepareBitacoraImport(request) {
    const email = String(request.auth?.token?.email || "").toLowerCase();
    if (!request.auth || !email) throw new HttpsError("unauthenticated", "Inicia sesión para importar.");
    const profile = await db.collection("users").doc(email).get();
    const access = report.resolveAccess(profile.exists ? profile.data() : null, ["import-preview"]);
    if (!access.allowed || access.kind !== "admin") throw new HttpsError("permission-denied", "Solo administración puede preparar importaciones.");
    let input;
    try { input = bitacoraImport.validateRequest(request.data); }
    catch (error) { throw new HttpsError("invalid-argument", error.message); }
    const usage = db.collection("ai_import_usage").doc(`${request.auth.uid}_${new Date().toISOString().slice(0, 10)}`);
    await db.runTransaction(async tx => {
      const snapshot = await tx.get(usage);
      const count = Number(snapshot.get("count") || 0);
      if (count >= 60) throw new HttpsError("resource-exhausted", "Alcanzaste 60 análisis hoy. Continúa mañana.");
      tx.set(usage, { count: count + 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });
    try {
      const response = await getGenAI().models.generateContent({
        model: AI_MODEL.value(),
        contents: [{ role: "user", parts: [{ text: "Ordena estas bitácoras sin completar información ausente.\n" + input.text },
          ...input.files.map(file => ({ inlineData: file }))] }],
        config: { systemInstruction: bitacoraImport.instruction(), temperature: 0,
          responseMimeType: "application/json", responseSchema: bitacoraImport.schema,
          maxOutputTokens: 24576, thinkingConfig: { thinkingBudget: 0 } },
      });
      if (response.candidates?.[0]?.finishReason === "MAX_TOKENS") throw Error("El documento es demasiado largo. Divídelo en partes.");
      const result = bitacoraImport.cleanOutput(response.text, input);
      logger.info("Importación IA preparada", { classes: result.classes.length, files: input.files.length, usage: response.usageMetadata });
      return result;
    } catch (error) {
      await usage.update({ count: FieldValue.increment(-1) }).catch(() => {});
      logger.error("Falló importación IA", { error: error.message });
      throw new HttpsError("unavailable", "No se pudo preparar la importación. " + (error.message?.includes("Divide") || error.message?.includes("Divídelo") ? error.message : "Tu contenido se conserva; intenta de nuevo."));
    }
}

// js/ui/students.ui.js

import { CONFIG } from "../config.js";
import { getState } from "../state.js";
import { getStudentDisplayData, selectStudent } from "../services/students.service.js";
import {
  qs,
  renderHtml,
  delegate,
  escapeHtml,
} from "./dom.js";

const DEFAULT_SELECTORS = {
  results: "#students-results",
  preview: "#student-preview-content",
  summary: "#search-summary",
};

let cleanupFns = [];

export function destroyStudentsUI() {
  cleanupFns.forEach((cleanup) => {
    try {
      cleanup();
    } catch (error) {
      console.warn("No se pudo limpiar students.ui:", error);
    }
  });

  cleanupFns = [];
}

export function mountStudentsUI(options = {}) {
  destroyStudentsUI();

  const {
    root = document,
    selectors = DEFAULT_SELECTORS,
    onSelect = null,
    onOpenProfile = null,
    onOpenEditor = null,
  } = options;

  const resultsEl = qs(selectors.results, root);
  const previewEl = qs(selectors.preview, root);

  if (resultsEl) {
    cleanupFns.push(
      delegate(resultsEl, "click", "[data-student-id]", (event, card) => {
        handleStudentCardClick(event, card, {
          onSelect,
          onOpenProfile,
          onOpenEditor,
        });
      })
    );

    cleanupFns.push(
      delegate(resultsEl, "keydown", "[data-student-id]", (event, card) => {
        if (event.key !== "Enter" && event.key !== " ") return;

        event.preventDefault();
        handleStudentCardClick(event, card, {
          onSelect,
          onOpenProfile,
          onOpenEditor,
        });
      })
    );
  }

  if (previewEl) {
    cleanupFns.push(
      delegate(previewEl, "click", "[data-student-preview-action]", (event, button) => {
        const action = button.dataset.studentPreviewAction;
        const state = getState();
        const selectedStudent =
          state.students?.selected ||
          state.students?.byId?.[state.search?.selectedStudentId] ||
          null;

        if (!selectedStudent) return;

        if (action === "profile" && typeof onOpenProfile === "function") {
          onOpenProfile(selectedStudent, event);
          return;
        }

        if (action === "editor" && typeof onOpenEditor === "function") {
          onOpenEditor(selectedStudent, event);
        }
      })
    );
  }
}

export function renderStudentsUI(state = getState(), options = {}) {
  renderStudentsSummary(state, options);
  renderStudentsResults(state, options);
  renderStudentPreview(state, options);
}

export function renderStudentsSummary(state = getState(), options = {}) {
  const {
    root = document,
    selectors = DEFAULT_SELECTORS,
  } = options;

  const summaryEl = qs(selectors.summary, root);
  if (!summaryEl) return;

  const total = Array.isArray(state?.search?.results) ? state.search.results.length : 0;
  const filtered = Array.isArray(state?.search?.filteredResults)
    ? state.search.filteredResults.length
    : 0;
  const query = String(state?.search?.query || "").trim();
  const loading = Boolean(state?.students?.loading);

  if (loading) {
    renderHtml(
      summaryEl,
      `<p class="search-summary__text">${escapeHtml(CONFIG.text.loading)}</p>`
    );
    return;
  }

  if (!total) {
    renderHtml(
      summaryEl,
      `<p class="search-summary__text">No hay estudiantes cargados todavía.</p>`
    );
    return;
  }

  if (!query) {
    renderHtml(
      summaryEl,
      `
        <p class="search-summary__text">
          ${total} estudiante${total === 1 ? "" : "s"} disponible${total === 1 ? "" : "s"}.
        </p>
      `
    );
    return;
  }

  renderHtml(
    summaryEl,
    `
      <p class="search-summary__text">
        ${filtered} resultado${filtered === 1 ? "" : "s"} para
        <strong>${escapeHtml(query)}</strong>.
      </p>
    `
  );
}

export function renderStudentsResults(state = getState(), options = {}) {
  const {
    root = document,
    selectors = DEFAULT_SELECTORS,
    emptyMessage = CONFIG.text.emptyStudents,
  } = options;

  const resultsEl = qs(selectors.results, root);
  if (!resultsEl) return;

  const students = Array.isArray(state?.search?.filteredResults)
    ? state.search.filteredResults
    : [];

  const loading = Boolean(state?.students?.loading);
  const selectedStudentId =
    state?.students?.selected?.id ||
    state?.search?.selectedStudentId ||
    null;

  if (loading) {
    renderHtml(resultsEl, renderLoadingResults());
    return;
  }

  if (!students.length) {
    renderHtml(resultsEl, renderEmptyResults(emptyMessage));
    return;
  }

  renderHtml(
    resultsEl,
    students
      .map((student) =>
        renderStudentCard(student, {
          selected: selectedStudentId === student?.id,
        })
      )
      .join("")
  );
}

export function renderStudentPreview(state = getState(), options = {}) {
  const {
    root = document,
    selectors = DEFAULT_SELECTORS,
  } = options;

  const previewEl = qs(selectors.preview, root);
  if (!previewEl) return;

  const student =
    state?.students?.selected ||
    state?.students?.byId?.[state?.search?.selectedStudentId] ||
    null;

  if (!student) {
    renderHtml(previewEl, renderEmptyPreview());
    return;
  }

  renderHtml(previewEl, renderPreviewCard(student));
}

export function renderStudentCard(student, options = {}) {
  const { selected = false } = options;
  const data = getSafeStudentDisplayData(student);

  return `
    <article
      class="student-card ${selected ? "is-selected" : ""}"
      data-student-id="${escapeHtml(data.id)}"
      role="listitem"
      tabindex="0"
      aria-selected="${selected ? "true" : "false"}"
    >
      <div class="student-card__main">
        <div class="student-card__identity">
          <h3 class="student-card__name">${escapeHtml(data.name || "Sin nombre")}</h3>
          <p class="student-card__document">
            ${escapeHtml(data.documentNumber || "Sin documento")}
          </p>
        </div>

        <div class="student-card__badges">
          ${renderBadge(data.modality)}
          ${renderBadge(data.instrument)}
          ${renderBadge(data.sede)}
          ${renderBadge(data.statusLabel)}
        </div>

        <div class="student-card__meta">
          <p><strong>Docente:</strong> ${escapeHtml(data.teacherName || "No registrado")}</p>
          <p><strong>Acudiente:</strong> ${escapeHtml(data.guardianName || "No registrado")}</p>
        </div>
      </div>

      <div class="student-card__actions">
        <button
          type="button"
          class="btn btn--ghost btn--sm"
          data-student-action="profile"
        >
          Perfil
        </button>
        <button
          type="button"
          class="btn btn--primary btn--sm"
          data-student-action="editor"
        >
          Bitácora
        </button>
      </div>
    </article>
  `;
}

export function renderPreviewCard(student) {
  const data = getSafeStudentDisplayData(student);

  return `
    <article class="preview-student">
      <div class="preview-student__identity">
        <p class="preview-student__eyebrow">Estudiante seleccionado</p>
        <h3 class="preview-student__name">${escapeHtml(data.name || "Sin nombre")}</h3>
        <p class="preview-student__meta">
          ${escapeHtml(data.documentNumber || "Sin documento")}
        </p>
      </div>

      <dl class="preview-grid">
        ${renderPreviewItem("Edad", data.ageLabel)}
        ${renderPreviewItem("Modalidad", data.modality || "No registrada")}
        ${renderPreviewItem("Área", data.instrument || "No registrada")}
        ${renderPreviewItem("Docente", data.teacherName || "No registrado")}
        ${renderPreviewItem("Sede", data.sede || "No registrada")}
        ${renderPreviewItem("Jornada", data.jornada || "No registrada")}
        ${renderPreviewItem("Acudiente", data.guardianName || "No registrado")}
        ${renderPreviewItem("Contacto", data.guardianPhone || data.phone || "No registrado")}
      </dl>

      <div class="preview-actions">
        <button
          type="button"
          class="btn btn--primary"
          data-student-preview-action="editor"
        >
          Abrir editor
        </button>
        <button
          type="button"
          class="btn btn--ghost"
          data-student-preview-action="profile"
        >
          Ver perfil
        </button>
      </div>
    </article>
  `;
}

export function renderLoadingResults() {
  return `
    <div class="loading-state">
      <p class="loading-state__text">${escapeHtml(CONFIG.text.loading)}</p>
    </div>
  `;
}

export function renderEmptyResults(message = CONFIG.text.emptyStudents) {
  return `
    <div class="empty-state">
      <p class="empty-state__text">${escapeHtml(message)}</p>
    </div>
  `;
}

export function renderEmptyPreview() {
  return `
    <div class="empty-state empty-state--preview">
      <p class="empty-state__text">
        Seleccionen un estudiante para ver su información rápida.
      </p>
    </div>
  `;
}

function handleStudentCardClick(event, card, handlers = {}) {
  const studentId = String(card?.dataset?.studentId || "").trim();
  if (!studentId) return;

  let selectedStudent = null;

  try {
    selectedStudent = selectStudent(studentId);
  } catch (error) {
    console.error("No se pudo seleccionar el estudiante:", error);
    return;
  }

  const actionButton = event.target.closest("[data-student-action]");
  const action = actionButton?.dataset?.studentAction || null;

  if (typeof handlers.onSelect === "function") {
    handlers.onSelect(selectedStudent, event);
  }

  if (action === "profile" && typeof handlers.onOpenProfile === "function") {
    handlers.onOpenProfile(selectedStudent, event);
    return;
  }

  if (action === "editor" && typeof handlers.onOpenEditor === "function") {
    handlers.onOpenEditor(selectedStudent, event);
  }
}

function renderPreviewItem(label, value) {
  return `
    <div class="preview-grid__item">
      <dt class="preview-grid__label">${escapeHtml(label)}</dt>
      <dd class="preview-grid__value">${escapeHtml(String(value ?? ""))}</dd>
    </div>
  `;
}

function renderBadge(value) {
  if (!value) return "";
  return `<span class="badge">${escapeHtml(value)}</span>`;
}

function getSafeStudentDisplayData(student) {
  try {
    const display = getStudentDisplayData(student) || {};
    const sourceProfile = student?.profile || {};

    const documentNumber =
      sourceProfile.documentNumber ||
      student?.documentNumber ||
      student?.documento ||
      student?.identificacion ||
      "";

    const age =
      sourceProfile.age ||
      student?.age ||
      student?.edad ||
      0;

    const statusLabel =
      normalizeStatusLabel(display.status || student?.status || "");

    return {
      ...display,
      documentNumber,
      ageLabel: age ? `${age} años` : "No registrada",
      guardianName:
        display.guardianName ||
        student?.guardian?.name ||
        student?.acudiente ||
        student?.responsable ||
        "",
      guardianPhone:
        display.guardianPhone ||
        student?.guardian?.phone ||
        "",
      phone:
        display.phone ||
        student?.phone ||
        student?.telefono ||
        "",
      teacherName:
        display.teacherName ||
        student?.teacherName ||
        student?.docente ||
        student?.teacher ||
        "",
      modality:
        display.modality ||
        student?.modality ||
        student?.modalidad ||
        "",
      instrument:
        display.instrument ||
        student?.instrument ||
        student?.area ||
        student?.programa ||
        student?.instrumento ||
        "",
      sede:
        display.sede ||
        student?.sede ||
        "",
      jornada:
        display.jornada ||
        student?.jornada ||
        "",
      statusLabel,
    };
  } catch (error) {
    console.warn("No se pudo preparar display data del estudiante:", error);

    return {
      id: String(student?.id || ""),
      name: String(student?.name || student?.nombre || "Sin nombre"),
      documentNumber: String(
        student?.documentNumber ||
          student?.documento ||
          student?.identificacion ||
          ""
      ),
      ageLabel: student?.edad ? `${student.edad} años` : "No registrada",
      guardianName: String(student?.acudiente || student?.responsable || ""),
      guardianPhone: "",
      phone: String(student?.telefono || ""),
      teacherName: String(student?.teacherName || student?.docente || ""),
      modality: String(student?.modality || student?.modalidad || ""),
      instrument: String(
        student?.instrument ||
          student?.area ||
          student?.programa ||
          student?.instrumento ||
          ""
      ),
      sede: String(student?.sede || ""),
      jornada: String(student?.jornada || ""),
      statusLabel: normalizeStatusLabel(student?.status || ""),
    };
  }
}

function normalizeStatusLabel(status) {
  const normalized = String(status || "").trim().toLowerCase();

  if (!normalized) return "";
  if (normalized === "active") return "Activo";
  if (normalized === "inactive") return "Inactivo";

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}
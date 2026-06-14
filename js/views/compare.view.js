import { CONFIG } from "../config.js";
import { resolveUserAccess } from "../authz.js";
import {
  getState,
  setAppError,
  clearAppError,
  setStudentsList,
  setStudentsLoading,
  addSelectedStudentId,
  removeSelectedStudentId,
  clearSelectedStudentIds,
  getSelectedStudentIds,
} from "../state.js";
import { getStudents } from "../api/students.api.js";
import { getBitacorasByStudent } from "../api/bitacoras.api.js";
import {
  escapeHtml,
  formatDisplayDate,
  getReadableValue,
  getStudentCondition,
  getStudentDocument,
  getStudentIdentity,
  getStudentName,
  getStudentProcessesSummary,
  matchesFlexibleSearch,
  normalizeText,
  sortBitacorasByDate,
  toStringSafe,
} from "../utils/shared.js";

let viewRoot = null;
let currentSubscribe = null;
let unsubscribeView = null;
let searchQuery = "";
let loadingLatest = false;
const latestByStudentId = new Map();
const historyByStudentId = new Map();
const latestErrors = new Map();
const historyOpenStudentIds = new Set();
const historyLoadingStudentIds = new Set();

export async function beforeEnter() {
  clearAppError();
  if (!canUseCompare(getState()?.auth?.user)) return;
  await ensureStudentsLoaded();
}

export async function render({ root, state, subscribe }) {
  viewRoot = root;
  currentSubscribe = typeof subscribe === "function" ? subscribe : null;

  root.innerHTML = buildCompareMarkup(state || getState());
  bindEvents();
  setupSubscription();
  await refreshLatestBitacoras();
}

export function beforeLeave() {
  cleanup();
}

export function destroy() {
  cleanup();
}

async function ensureStudentsLoaded() {
  const state = getState();
  if (Array.isArray(state?.students?.allIds) && state.students.allIds.length) {
    return;
  }

  setStudentsLoading(true);
  try {
    setStudentsList(await getStudents());
  } catch (error) {
    console.error("Error cargando estudiantes para comparación:", error);
    setAppError(error?.message || "No se pudieron cargar los estudiantes.");
  } finally {
    setStudentsLoading(false);
  }
}

function setupSubscription() {
  if (unsubscribeView) {
    unsubscribeView();
    unsubscribeView = null;
  }

  if (!currentSubscribe) return;

  unsubscribeView = currentSubscribe((nextState) => {
    if (!viewRoot || !viewRoot.isConnected) return;
    renderDynamicBlocks(nextState || getState());
  });
}

function bindEvents() {
  viewRoot?.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.id !== "compare-student-search") return;
    searchQuery = target.value || "";
    renderDynamicBlocks(getState());
  });

  viewRoot?.addEventListener("click", async (event) => {
    const button = event.target?.closest?.("[data-compare-action]");
    if (!button) return;

    const action = button.dataset.compareAction || "";
    const studentId = button.dataset.studentId || "";

    if (action === "toggle-student") {
      const selected = getSelectedStudentIds();
      if (selected.includes(studentId)) {
        removeSelectedStudentId(studentId);
      } else {
        addSelectedStudentId(studentId);
      }
      await refreshLatestBitacoras();
      return;
    }

    if (action === "clear-selection") {
      clearSelectedStudentIds();
      renderDynamicBlocks(getState());
      return;
    }

    if (action === "refresh-latest") {
      await refreshLatestBitacoras(true);
      return;
    }

    if (action === "toggle-history") {
      if (historyOpenStudentIds.has(studentId)) {
        historyOpenStudentIds.delete(studentId);
        renderDynamicBlocks(getState());
        return;
      }

      historyOpenStudentIds.add(studentId);
      await ensureStudentHistoryLoaded(studentId);
    }
  });
}

async function refreshLatestBitacoras(force = false) {
  const ids = getSelectedStudentIds();
  const missing = ids.filter((id) => force || !latestByStudentId.has(id));
  if (!missing.length) {
    renderDynamicBlocks(getState());
    return;
  }

  loadingLatest = true;
  renderDynamicBlocks(getState());

  await Promise.all(
    missing.map(async (studentId) => {
      latestErrors.delete(studentId);
      try {
        const items = await getBitacorasByStudent(studentId, { limit: 8 });
        latestByStudentId.set(studentId, sortBitacorasByDate(items)[0] || null);
      } catch (error) {
        console.error("Error cargando última bitácora:", studentId, error);
        latestByStudentId.set(studentId, null);
        latestErrors.set(
          studentId,
          error?.message || "No se pudo consultar la última bitácora."
        );
      }
    })
  );

  loadingLatest = false;
  renderDynamicBlocks(getState());
}

async function ensureStudentHistoryLoaded(studentId) {
  const safeStudentId = toStringSafe(studentId);
  if (!safeStudentId || historyByStudentId.has(safeStudentId)) {
    renderDynamicBlocks(getState());
    return;
  }

  historyLoadingStudentIds.add(safeStudentId);
  renderDynamicBlocks(getState());

  try {
    const items = await getBitacorasByStudent(safeStudentId, {
      limit: CONFIG.limits.maxRecentBitacoras || 50,
    });
    historyByStudentId.set(safeStudentId, sortBitacorasByDate(items));
  } catch (error) {
    console.error("Error cargando historial de bitácoras:", safeStudentId, error);
    latestErrors.set(
      safeStudentId,
      error?.message || "No se pudo consultar el historial completo."
    );
  } finally {
    historyLoadingStudentIds.delete(safeStudentId);
    renderDynamicBlocks(getState());
  }
}

function buildCompareMarkup(state) {
  if (!canUseCompare(state?.auth?.user)) {
    return `
      <section class="view-shell view-shell--compare">
        <div class="card empty-state-card">
          <p class="view-eyebrow">Comparar bitácoras</p>
          <h1 class="view-title">Acceso docente requerido</h1>
          <p class="view-description">Inicia sesión con una cuenta autorizada para usar esta herramienta.</p>
        </div>
      </section>
    `;
  }

  return `
    <section class="view-shell view-shell--compare">
      <header class="view-header">
        <div class="view-header__content">
          <p class="view-eyebrow">Herramienta docente</p>
          <h1 class="view-title">Comparar bitácoras de grupo</h1>
          <p class="view-description">Selecciona varios estudiantes, revisa la última clase y abre el historial completo cuando necesites más contexto.</p>
        </div>
      </header>

      <section class="compare-layout">
        <aside class="card compare-picker">
          <label class="field">
            <span class="field__label">Buscar estudiantes</span>
            <input
              id="compare-student-search"
              class="field__input"
              type="search"
              placeholder="Nombre, documento, docente, arte..."
              value="${escapeHtml(searchQuery)}"
              autocomplete="off"
            />
          </label>
          <div class="compare-picker__actions">
            <button type="button" class="btn btn--ghost btn--sm" data-compare-action="clear-selection">Limpiar</button>
            <button type="button" class="btn btn--secondary btn--sm" data-compare-action="refresh-latest">Actualizar</button>
          </div>
          <div id="compare-student-results" class="compare-student-results"></div>
        </aside>

        <main class="compare-main">
          <div id="compare-selected-summary"></div>
          <div id="compare-cards" class="compare-cards"></div>
        </main>
      </section>
    </section>
  `;
}

function renderDynamicBlocks(state) {
  const results = viewRoot?.querySelector("#compare-student-results");
  const summary = viewRoot?.querySelector("#compare-selected-summary");
  const cards = viewRoot?.querySelector("#compare-cards");
  if (!results || !summary || !cards) return;

  const students = getAllStudents(state);
  const selectedIds = getSelectedStudentIds();
  const selectedStudents = selectedIds
    .map((id) => students.find((student) => getStudentIdentity(student) === id))
    .filter(Boolean);

  results.innerHTML = renderStudentResults(students, selectedIds);
  summary.innerHTML = renderSelectedSummary(selectedStudents);
  cards.innerHTML = renderCompareCards(selectedStudents);
}

function renderStudentResults(students = [], selectedIds = []) {
  const query = normalizeText(searchQuery);
  const visible = students
    .filter((student) => {
      if (!query) return selectedIds.includes(getStudentIdentity(student));
      return matchesFlexibleSearch(
        [
          getStudentName(student),
          getStudentDocument(student),
          getStudentProcessesSummary(student),
          student?.docente,
          student?.teacher,
          student?.area,
          student?.instrumento,
          student?.programa,
        ],
        searchQuery
      );
    })
    .slice(0, query ? 30 : 12);

  if (!visible.length) {
    return `<p class="empty-state__text">Busca por nombre o documento para agregar estudiantes.</p>`;
  }

  return visible
    .map((student) => {
      const id = getStudentIdentity(student);
      const selected = selectedIds.includes(id);
      return `
        <button
          type="button"
          class="compare-student-row ${selected ? "is-selected" : ""}"
          data-compare-action="toggle-student"
          data-student-id="${escapeHtml(id)}"
        >
          <span>
            <strong>${escapeHtml(getStudentName(student))}</strong>
            <small>${escapeHtml(getStudentDocument(student) || "Sin documento")}</small>
          </span>
          <span class="badge ${selected ? "badge--blue" : "badge--soft"}">${selected ? "Agregado" : "Agregar"}</span>
        </button>
      `;
    })
    .join("");
}

function renderSelectedSummary(students = []) {
  return `
    <section class="compare-summary">
      <div>
        <p class="panel-header__eyebrow">Selección</p>
        <h2 class="panel-header__title">${escapeHtml(students.length)} estudiante${students.length === 1 ? "" : "s"} para comparar</h2>
      </div>
      ${loadingLatest ? `<p class="field__hint">Cargando últimas bitácoras...</p>` : ""}
    </section>
  `;
}

function renderCompareCards(students = []) {
  if (!students.length) {
    return `
      <div class="card empty-state-card">
        <p class="empty-state__title">Selecciona el grupo</p>
        <p class="empty-state__text">Agrega dos o más estudiantes para comparar rápidamente lo último que trabajó cada uno.</p>
      </div>
    `;
  }

  return students.map(renderCompareCard).join("");
}

function renderCompareCard(student) {
  const id = getStudentIdentity(student);
  const latest = latestByStudentId.get(id);
  const error = latestErrors.get(id);
  const historyOpen = historyOpenStudentIds.has(id);
  const historyItems = historyByStudentId.get(id) || [];
  const historyLoading = historyLoadingStudentIds.has(id);

  return `
    <article class="card compare-card">
      <header class="compare-card__header">
        <div>
          <h3 class="compare-card__name">${escapeHtml(getStudentName(student))}</h3>
          <p class="compare-card__meta">${escapeHtml(getStudentDocument(student) || "Sin documento")}</p>
        </div>
        <div class="compare-card__actions">
          <button type="button" class="btn btn--ghost btn--sm" data-compare-action="toggle-history" data-student-id="${escapeHtml(id)}">
            ${historyOpen ? "Ocultar" : "Historial"}
          </button>
          <button type="button" class="btn btn--ghost btn--sm" data-compare-action="toggle-student" data-student-id="${escapeHtml(id)}">Quitar</button>
        </div>
      </header>
      <dl class="compare-card__facts">
        ${renderFact("Proceso", getReadableValue(getStudentProcessesSummary(student), "Sin proceso"))}
        ${renderFact("Condición", getReadableValue(getStudentCondition(student), "Sin condición registrada"))}
      </dl>
      ${
        error
          ? `<p class="message-box message-box--warning">${escapeHtml(error)}</p>`
          : latest
          ? renderLatestBitacora(latest, student)
          : `<div class="empty-state empty-state--files"><p class="empty-state__text">Sin bitácoras registradas.</p></div>`
      }
      ${historyOpen ? renderFullHistory(historyItems, student, historyLoading) : ""}
    </article>
  `;
}

function renderLatestBitacora(item = {}, student = {}) {
  const override = getStudentOverride(item, getStudentIdentity(student));
  const structured = parseBitacoraContent(item.content || item.contenido);
  const content =
    toStringSafe(override?.tareas) ||
    structured.tareas ||
    toStringSafe(item.content || item.contenido);
  const tags = normalizeList(override?.etiquetas || item.tags || item.etiquetas);
  const components = [
    ...normalizeList(override?.componenteCorporal || structured.componenteCorporal),
    ...normalizeList(override?.componenteTecnico || structured.componenteTecnico),
    ...normalizeList(override?.componenteTeorico || structured.componenteTeorico),
    ...normalizeList(override?.componenteObras || structured.componenteObras),
  ];

  return `
    <section class="compare-card__bitacora">
      <div class="compare-card__bitacora-head">
        <p class="compare-card__date">${escapeHtml(formatDisplayDate(item.fechaClase || item.createdAt))}</p>
        <h4 class="compare-card__title">${escapeHtml(item.title || item.titulo || "Última bitácora")}</h4>
      </div>
      ${tags.length ? `<div class="compare-chip-row">${tags.map((tag) => `<span class="badge">${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
      <p class="compare-card__text">${escapeHtml(content || "Sin observación registrada.")}</p>
      ${components.length ? `<div class="compare-chip-row">${components.map((value) => `<span class="badge badge--soft">${escapeHtml(value)}</span>`).join("")}</div>` : ""}
    </section>
  `;
}

function renderFullHistory(items = [], student = {}, isLoading = false) {
  if (isLoading) {
    return `
      <section class="compare-history">
        <p class="field__hint">Cargando historial completo...</p>
      </section>
    `;
  }

  if (!items.length) {
    return `
      <section class="compare-history">
        <p class="empty-state__text">No hay más bitácoras para mostrar.</p>
      </section>
    `;
  }

  return `
    <section class="compare-history">
      <div class="compare-history__header">
        <p class="panel-header__eyebrow">Historial completo</p>
        <span class="badge badge--soft">${escapeHtml(items.length)} registros</span>
      </div>
      <div class="compare-history__list">
        ${items.map((item) => renderHistoryItem(item, student, true)).join("")}
      </div>
    </section>
  `;
}

function renderHistoryItem(item = {}, student = {}, open = false) {
  return `
    <details class="compare-history-item" ${open ? "open" : ""}>
      <summary>
        <span>${escapeHtml(formatDisplayDate(item.fechaClase || item.createdAt))}</span>
        <strong>${escapeHtml(item.title || item.titulo || "Bitácora")}</strong>
      </summary>
      ${renderLatestBitacora(item, student)}
    </details>
  `;
}

function renderFact(label, value) {
  return `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(value)}</dd>
    </div>
  `;
}

function getStudentOverride(item = {}, studentId = "") {
  const overrides = item.studentOverrides || item.overrides || {};
  return overrides?.[studentId] || null;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(toStringSafe).filter(Boolean);
  // Separamos por salto de linea (no por coma): los nombres de los items pueden
  // contener comas y no deben fragmentarse.
  return toStringSafe(value)
    .split(/\n/g)
    .map(toStringSafe)
    .filter(Boolean);
}

function parseBitacoraContent(content = "") {
  const result = {
    tareas: "",
    componenteCorporal: [],
    componenteTecnico: [],
    componenteTeorico: [],
    componenteObras: [],
  };
  const current = { key: "tareas" };

  toStringSafe(content)
    .split(/\r?\n/g)
    .forEach((line) => {
      const parsed = parseStructuredLine(line);
      if (parsed) {
        current.key = parsed.key;
        appendParsedValue(result, parsed.key, parsed.value);
        return;
      }
      appendParsedValue(result, current.key, line);
    });

  result.tareas = result.tareas.trim();
  return result;
}

function parseStructuredLine(line = "") {
  const match = toStringSafe(line).match(/^([^:]+):\s*(.*)$/);
  if (!match) return null;
  const label = normalizeText(match[1]);
  const value = match[2] || "";

  if (label.includes("tareas") || label.includes("observaciones")) {
    return { key: "tareas", value };
  }
  if (label.includes("corporal")) return { key: "componenteCorporal", value };
  if (label.includes("tecnico")) return { key: "componenteTecnico", value };
  if (label.includes("teorico")) return { key: "componenteTeorico", value };
  if (label.includes("obra") || label.includes("repertorio")) {
    return { key: "componenteObras", value };
  }
  return null;
}

function appendParsedValue(target, key, value) {
  const safeValue = toStringSafe(value);
  if (!safeValue) return;
  if (key === "tareas") {
    target.tareas = [target.tareas, safeValue].filter(Boolean).join("\n");
    return;
  }
  target[key] = [...(target[key] || []), ...normalizeList(safeValue)];
}

function getAllStudents(state = {}) {
  const byId = state?.students?.byId || {};
  return Array.isArray(state?.students?.allIds)
    ? state.students.allIds.map((id) => byId[id]).filter(Boolean)
    : [];
}

function canUseCompare(user) {
  const access = resolveUserAccess(user);
  return access.role === CONFIG.roles.admin || access.role === CONFIG.roles.teacher;
}

function cleanup() {
  if (unsubscribeView) {
    unsubscribeView();
    unsubscribeView = null;
  }
  viewRoot = null;
  currentSubscribe = null;
}

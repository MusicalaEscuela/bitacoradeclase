import { CONFIG } from "../config.js";
import { resolveUserAccess } from "../authz.js";
import {
  getState,
  setAppError,
  clearAppError,
  setSearchQuery,
  setSearchResults,
  setFilteredResults,
  setSelectedStudent,
  addSelectedStudentId,
  removeSelectedStudentId,
  clearSelectedStudentIds,
  setStudentsList,
  setStudentsLoading,
  getSelectedStudentIds,
} from "../state.js";
import { getStudents } from "../api/students.api.js";
import {
  escapeHtml,
  getReadableValue,
  getStudentDocument,
  getStudentIdentity,
  getStudentName,
  getStudentProcessesSummary,
  matchesStudentRef,
  normalizeText,
  resolveStudentRefFromPayload,
  toStringSafe,
} from "../utils/shared.js";

let viewRoot = null;
let unsubscribeView = null;
let currentNavigateTo = null;
let currentSubscribe = null;
let currentModalStudentId = null;
let hasRetriedInitialLoad = false;

export async function beforeEnter({ payload } = {}) {
  clearAppError();
  await ensureStudentsLoaded(payload);
}

export async function render({
  root,
  state,
  config,
  navigateTo,
  payload,
  subscribe,
}) {
  viewRoot = root;
  currentNavigateTo = typeof navigateTo === "function" ? navigateTo : null;
  currentSubscribe = typeof subscribe === "function" ? subscribe : null;

  const safeState = state || getState();
  const safeConfig = config || CONFIG;
  const selectedFromPayload = resolveStudentRefFromPayload(payload);

  if (selectedFromPayload) {
    syncSelectedStudentFromId(selectedFromPayload, safeState);
  }

  root.innerHTML = buildSearchViewMarkup(safeState, safeConfig);

  bindViewEvents();
  renderSummary(getState(), safeConfig);
  renderResults(getState());
  renderStudentModal(getState());
  syncInputValue(getState());

  if (unsubscribeView) {
    unsubscribeView();
    unsubscribeView = null;
  }

  if (currentSubscribe) {
    unsubscribeView = currentSubscribe((nextState) => {
      const safeNextState = nextState || getState();
      if (!viewRoot || !viewRoot.isConnected) return;

      const hasStudents = Array.isArray(safeNextState?.students?.allIds)
        ? safeNextState.students.allIds.length > 0
        : false;
      const isLoading = Boolean(safeNextState?.students?.loading);
      const authReady = Boolean(safeNextState?.auth?.ready);

      if (authReady && !hasStudents && !isLoading && !hasRetriedInitialLoad) {
        hasRetriedInitialLoad = true;
        refreshStudents().catch((error) => {
          console.error("Error reintentando carga inicial de estudiantes:", error);
        });
      }

      renderSummary(safeNextState, safeConfig);
      renderResults(safeNextState);
      renderStudentModal(safeNextState);
      syncInputValue(safeNextState);
    });
  }
}

export async function afterEnter() {
  const input = viewRoot?.querySelector("#student-search-input");
  if (input) input.focus();
}

export function beforeLeave() {
  cleanupView();
}

export function destroy() {
  cleanupView();
}

async function ensureStudentsLoaded(payload = {}) {
  const state = getState();
  const currentIds = Array.isArray(state?.students?.allIds)
    ? state.students.allIds
    : [];
  const hasStudents = currentIds.length > 0;

  if (hasStudents) {
    const students = currentIds
      .map((id) => state.students.byId?.[id])
      .filter(Boolean);
    const visibleStudents = getVisibleStudents(state, students);

    setSearchResults(students);
    setFilteredResults(filterStudents(visibleStudents, state?.search?.query || ""));
    ensureInitialSelection(visibleStudents, state, payload);
    return;
  }

  await refreshStudents(payload);
}

async function refreshStudents(payload = {}) {
  clearAppError();
  setStudentsLoading(true);

  try {
    const students = await safeLoadStudents();
    const state = getState();
    const query = state?.search?.query || "";
    const visibleStudents = getVisibleStudents(state, students);

    setStudentsList(students);
    setSearchResults(students);
    setFilteredResults(filterStudents(visibleStudents, query));
    ensureInitialSelection(visibleStudents, state, payload);
  } catch (error) {
    console.error("Error cargando estudiantes:", error);
    setAppError(error?.message || "No se pudieron cargar los estudiantes.");
  } finally {
    setStudentsLoading(false);
  }
}

function ensureInitialSelection(students, state, payload = {}) {
  if (!Array.isArray(students) || !students.length) return;

  const selectedFromPayload = resolveStudentRefFromPayload(payload);
  const selectedId =
    selectedFromPayload ||
    state?.search?.selectedStudentId ||
    state?.students?.selected?.id ||
    null;

  if (selectedId) {
    const selected = students.find((student) =>
      matchesStudentRef(student, selectedId)
    );

    if (selected) {
      setSelectedStudent(selected);
      return;
    }
  }

  if (!state?.students?.selected) {
    setSelectedStudent(students[0]);
  }
}

function getVisibleStudents(state, students = []) {
  const access = resolveUserAccess(state?.auth?.user);
  if (access.role !== CONFIG.roles.student) {
    return students;
  }

  return students.filter((student) =>
    getStudentIdentity(student) === access.linkedStudentId
  );
}

function buildSearchViewMarkup(state, config) {
  const query = escapeHtml(state?.search?.query || "");
  const access = resolveUserAccess(state?.auth?.user);
  const isStudent = access.role === CONFIG.roles.student;
  const title =
    config?.app?.name ||
    config?.appName ||
    config?.title ||
    "Bitácoras de Clase";

  return `
    <section class="view-shell view-shell--search">
      <header class="view-header">
        <div class="view-header__content">
          <p class="view-eyebrow">${escapeHtml(title)}</p>
          <h1 class="view-title">Búsqueda de estudiantes</h1>
          <p class="view-description">
            Busca por nombre, documento o proceso y entra rapido a perfil o
            bitacora desde una vista pensada para trabajar mejor en movil.
          </p>
        </div>
      </header>

      <section class="search-toolbar" aria-label="Filtros de búsqueda">
        <div class="search-toolbar__grid">
          <label class="field search-toolbar__field">
            <span class="field__label">Buscar estudiante</span>
            <input
              id="student-search-input"
              class="field__input"
              type="search"
              placeholder="Nombre, documento, acudiente, docente, programa..."
              value="${query}"
              autocomplete="off"
            />
          </label>

          <div class="search-toolbar__actions">
            <button
              type="button"
              id="search-clear-btn"
              class="btn btn--ghost"
            >
              Limpiar
            </button>

            <button
              type="button"
              id="search-refresh-btn"
              class="btn btn--secondary"
            >
              Recargar
            </button>
          </div>
        </div>

        <div class="search-toolbar__bulk-actions">
          <button
            type="button"
            id="search-clear-selection-btn"
            class="btn btn--ghost btn--sm"
          >
            Limpiar selección grupal
          </button>

          <button
            type="button"
            id="search-open-group-editor-btn"
            class="btn btn--primary btn--sm"
          >
            Bitácora grupal
          </button>
        </div>

        <div id="search-summary" class="search-summary" aria-live="polite"></div>
      </section>

      <section class="search-layout search-layout--single" aria-label="Listado de estudiantes">
        <article class="search-results-panel">
          <header class="panel-header">
            <div>
              <p class="panel-header__eyebrow">Búsqueda guiada</p>
              <h2 class="panel-header__title">Resultados</h2>
            </div>
          </header>

          <div
            id="students-results"
            class="students-results"
            role="list"
            aria-label="Resultados de búsqueda"
          ></div>
        </article>
      </section>

      <div
        id="student-modal-root"
        class="student-modal-root is-hidden"
        aria-live="polite"
      ></div>
    </section>
  `;
}

function bindViewEvents() {
  if (!viewRoot) return;

  const access = resolveUserAccess(getState()?.auth?.user);

  const input = viewRoot.querySelector("#student-search-input");
  const clearBtn = viewRoot.querySelector("#search-clear-btn");
  const refreshBtn = viewRoot.querySelector("#search-refresh-btn");
  const clearSelectionBtn = viewRoot.querySelector("#search-clear-selection-btn");
  const openGroupEditorBtn = viewRoot.querySelector("#search-open-group-editor-btn");
  const resultsContainer = viewRoot.querySelector("#students-results");
  const modalRoot = viewRoot.querySelector("#student-modal-root");
  const bulkActions = viewRoot.querySelector(".search-toolbar__bulk-actions");

  if (bulkActions && access.role === CONFIG.roles.student) {
    bulkActions.hidden = true;
  }

  if (input) {
    input.addEventListener("input", handleSearchInput);
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", handleClearSearch);
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", handleRefreshStudents);
  }

  if (clearSelectionBtn) {
    clearSelectionBtn.addEventListener("click", handleClearSelection);
  }

  if (openGroupEditorBtn) {
    openGroupEditorBtn.addEventListener("click", handleOpenGroupEditor);
  }

  if (resultsContainer) {
    resultsContainer.addEventListener("click", handleResultsClick);
    resultsContainer.addEventListener("keydown", handleResultsKeydown);
    resultsContainer.addEventListener("change", handleSelectionCheckboxChange);
  }

  if (modalRoot) {
    modalRoot.addEventListener("click", handleModalClick);
  }
}

function handleSearchInput(event) {
  const query = String(event?.target?.value || "");
  const state = getState();
  const students = Array.isArray(state?.search?.results)
    ? state.search.results
    : [];

  setSearchQuery(query);
  setFilteredResults(filterStudents(students, query));
}

function handleClearSearch() {
  const state = getState();
  const allResults = Array.isArray(state?.search?.results)
    ? state.search.results
    : [];

  setSearchQuery("");
  setFilteredResults(filterStudents(allResults, ""));

  const input = viewRoot?.querySelector("#student-search-input");
  if (input) {
    input.value = "";
    input.focus();
  }
}

async function handleRefreshStudents() {
  await refreshStudents();
}

function handleClearSelection() {
  clearSelectedStudentIds();
  clearAppError();
}

function handleOpenGroupEditor() {
  const state = getState();
  const selectedIds = Array.isArray(state?.search?.selectedStudentIds)
    ? state.search.selectedStudentIds
    : [];

  if (selectedIds.length < 2) {
    setAppError(
      CONFIG?.text?.emptyGroup ||
        "Selecciona al menos dos estudiantes para abrir una bitácora grupal."
    );
    return;
  }

  const primaryStudent =
    state?.students?.selected ||
    getStudentById(selectedIds[0]) ||
    null;

  if (!primaryStudent) {
    setAppError("No se encontró el estudiante principal para la bitácora grupal.");
    return;
  }

  clearAppError();
  goToEditor(primaryStudent, {
    mode: CONFIG.modes.group,
    selectedStudentIds: selectedIds,
  });
}

function handleSelectionCheckboxChange(event) {
  const checkbox = event.target.closest("[data-student-select]");
  if (!checkbox) return;

  const studentId = toStringSafe(checkbox.getAttribute("data-student-select"));
  if (!studentId) return;

  if (checkbox.checked) {
    addSelectedStudentId(studentId);
  } else {
    removeSelectedStudentId(studentId);
  }

  clearAppError();
}

function handleResultsClick(event) {
  const checkbox = event.target.closest("[data-student-select]");
  if (checkbox) return;

  const actionButton = event.target.closest("[data-student-action]");
  const card = event.target.closest("[data-student-id]");
  if (!card) return;

  const studentId = toStringSafe(card.dataset.studentId);
  const student = getStudentById(studentId);
  if (!student) return;

  setSelectedStudent(student);

  const action = actionButton?.dataset?.studentAction || "details";

  if (action === "editor") {
    goToEditor(student);
    return;
  }

  if (action === "profile") {
    goToProfile(student);
    return;
  }

  openStudentModal(studentId);
}

function handleResultsKeydown(event) {
  const card = event.target.closest("[data-student-id]");
  if (!card) return;

  if (event.key !== "Enter" && event.key !== " ") return;

  event.preventDefault();

  const studentId = toStringSafe(card.dataset.studentId);
  const student = getStudentById(studentId);
  if (!student) return;

  setSelectedStudent(student);
  openStudentModal(studentId);
}

function handleModalClick(event) {
  event.preventDefault();
  event.stopPropagation();

  const closeButton = event.target.closest("[data-modal-close='button']");
  const clickedBackdrop = event.target.classList.contains("student-modal-backdrop");

  if (closeButton || clickedBackdrop) {
    closeStudentModal();
    return;
  }

  const actionButton = event.target.closest("[data-modal-action]");
  if (!actionButton) return;

  const action = actionButton.dataset.modalAction;
  const studentId = toStringSafe(actionButton.dataset.studentId || currentModalStudentId);
  const state = getState();
  const student =
    getStudentById(studentId) ||
    state?.students?.selected ||
    null;
  if (!student) return;

  if (action === "profile") {
    goToProfile(student);
    return;
  }

  if (action === "editor") {
    goToEditor(student);
    return;
  }

  if (action === "toggle-group") {
    toggleStudentInGroup(studentId);
    return;
  }

  if (action === "group-editor") {
    const selectedIds = getSelectedStudentIds();
    if (!selectedIds.includes(studentId)) {
      addSelectedStudentId(studentId);
    }
    handleOpenGroupEditor();
  }
}

function renderSummary(state, config) {
  const summaryNode = viewRoot?.querySelector("#search-summary");
  if (!summaryNode) return;

  const loading = Boolean(state?.students?.loading);
  const total = Array.isArray(state?.search?.results)
    ? state.search.results.length
    : 0;
  const filtered = Array.isArray(state?.search?.filteredResults)
    ? state.search.filteredResults.length
    : 0;
  const query = String(state?.search?.query || "").trim();
  const error = state?.app?.error || "";
  const selectedIds = Array.isArray(state?.search?.selectedStudentIds)
    ? state.search.selectedStudentIds
    : [];

  if (loading) {
    summaryNode.innerHTML = `
      <p class="search-summary__text">
        ${escapeHtml(config?.text?.loading || "Cargando estudiantes...")}
      </p>
    `;
    return;
  }

  if (error) {
    summaryNode.innerHTML = `
      <p class="search-summary__text search-summary__text--error">
        ${escapeHtml(String(error))}
      </p>
    `;
    return;
  }

  if (!total) {
    summaryNode.innerHTML = `
      <p class="search-summary__text">
        No hay estudiantes disponibles para mostrar.
      </p>
    `;
    return;
  }

  summaryNode.innerHTML = `
    <div class="search-summary__content">
      <p class="search-summary__text">
        ${
          !query
            ? `${total} estudiante${total === 1 ? "" : "s"} disponible${total === 1 ? "" : "s"}. Escribe para comenzar a buscar.`
            : query.length < 2
              ? `Escribe al menos 2 letras para buscar.`
              : `${filtered} resultado${filtered === 1 ? "" : "s"} para <strong>${escapeHtml(query)}</strong>.`
        }
      </p>
      <p class="search-summary__text">
        Selección grupal: <strong>${selectedIds.length}</strong>
      </p>
    </div>
  `;
}

function renderResults(state) {
  const container = viewRoot?.querySelector("#students-results");
  if (!container) return;

  const loading = Boolean(state?.students?.loading);
  const query = String(state?.search?.query || "").trim();
  const shouldRenderMatches = query.length >= 2;
  const students = shouldRenderMatches && Array.isArray(state?.search?.filteredResults)
    ? state.search.filteredResults
    : [];
  const selectedId =
    state?.students?.selected?.id ||
    state?.search?.selectedStudentId ||
    null;
  const selectedIds = Array.isArray(state?.search?.selectedStudentIds)
    ? state.search.selectedStudentIds
    : [];

  if (loading) {
    container.innerHTML = renderLoadingState();
    return;
  }

  if (!students.length) {
    container.innerHTML = renderEmptyResultsState(state);
    return;
  }

  container.innerHTML = students
    .map((student) =>
      renderStudentCard(
        student,
        matchesStudentRef(student, selectedId),
        selectedIds.includes(getStudentIdentity(student))
      )
    )
    .join("");
}

function renderStudentModal(state) {
  const modalRoot = viewRoot?.querySelector("#student-modal-root");
  if (!modalRoot) return;

  if (!currentModalStudentId) {
    modalRoot.classList.add("is-hidden");
    modalRoot.innerHTML = "";
    return;
  }

  const student =
    getStudentById(currentModalStudentId) ||
    state?.students?.selected ||
    null;

  if (!student) {
    currentModalStudentId = null;
    modalRoot.classList.add("is-hidden");
    modalRoot.innerHTML = "";
    return;
  }

  const selectedIds = getSelectedStudentIds();
  const isInGroup = selectedIds.includes(getStudentIdentity(student));
  const processSummary = getReadableValue(
    getStudentProcessesSummary(student),
    "No registrado"
  );

  modalRoot.classList.remove("is-hidden");
  modalRoot.innerHTML = `
    <div class="student-modal-backdrop" data-modal-close="backdrop">
      <article
        class="student-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="student-modal-title"
      >
        <header class="student-modal__header">
          <div class="student-modal__header-copy">
            <p class="student-modal__eyebrow">Ficha rápida</p>
            <h3 id="student-modal-title" class="student-modal__title">
              ${escapeHtml(getStudentName(student))}
            </h3>
            <p class="student-modal__document">
              ${escapeHtml(getStudentDocument(student) || "Sin documento")}
            </p>
          </div>

          <button
            type="button"
            class="btn btn--ghost btn--sm"
            data-modal-close="button"
            aria-label="Cerrar detalle del estudiante"
          >
            Cerrar
          </button>
        </header>

        <div class="student-modal__badges">
          ${renderBadge(student.estado)}
          ${renderBadge(student.modalidad)}
          ${renderBadge(student.area || student.programa || student.instrumento)}
          ${renderBadge(student.sede)}
          ${
            isInGroup
              ? '<span class="badge badge--blue">En selección grupal</span>'
              : ""
          }
        </div>

        <dl class="student-modal__grid">
          ${renderDetailItem("Estado", getReadableValue(student.estado))}
          ${renderDetailItem("Edad", getReadableValue(student.edad || student.age))}
          ${renderDetailItem("Procesos", processSummary)}
          ${renderDetailItem(
            "Intereses",
            getReadableValue(student.interesesMusicales || student.intereses)
          )}
          ${renderDetailItem(
            "Docente",
            getReadableValue(student.docente || student.teacher)
          )}
          ${renderDetailItem(
            "Acudiente",
            getReadableValue(student.acudiente || student.responsable)
          )}
        </dl>

        <div class="student-modal__actions">
          <button
            type="button"
            class="btn ${isInGroup ? "btn--ghost" : "btn--secondary"}"
            data-modal-action="toggle-group"
            data-student-id="${escapeHtml(getStudentIdentity(student))}"
          >
            ${isInGroup ? "Quitar del grupo" : "Agregar al grupo"}
          </button>

          <button
            type="button"
            class="btn btn--primary"
            data-modal-action="editor"
            data-student-id="${escapeHtml(getStudentIdentity(student))}"
          >
            Nueva bitácora
          </button>

          <button
            type="button"
            class="btn btn--ghost"
            data-modal-action="profile"
            data-student-id="${escapeHtml(getStudentIdentity(student))}"
          >
            Ver perfil
          </button>

          <button
            type="button"
            class="btn btn--soft"
            data-modal-action="group-editor"
            data-student-id="${escapeHtml(getStudentIdentity(student))}"
          >
            Abrir grupal
          </button>
        </div>
      </article>
    </div>
  `;
}

function renderStudentCard(student, isSelected = false, isChecked = false) {
  const identity = getStudentIdentity(student);
  const name = getStudentName(student);
  const documentValue = getStudentDocument(student) || "Sin documento";
  const teacher = getReadableValue(student.docente || student.teacher);
  const acudiente = getReadableValue(student.acudiente || student.responsable);

  const processBadges = Array.isArray(student.processes)
    ? student.processes
        .map((item) => item.arte || item.label || item.detalle)
        .filter(Boolean)
        .slice(0, 3)
    : [];

  const badges = [
    student.estado,
    student.modalidad,
    student.area,
    student.instrumento,
    student.programa,
    ...processBadges,
    student.sede,
  ].filter(Boolean);

  const uniqueBadges = [...new Set(badges.map((item) => toStringSafe(item)).filter(Boolean))].slice(
    0,
    4
  );

  return `
    <article
      class="student-card ${isSelected ? "is-selected" : ""}"
      data-student-id="${escapeHtml(identity)}"
      role="listitem"
      tabindex="0"
      aria-label="${escapeHtml(name)}"
    >
      <div class="student-card__selector">
        <label class="student-card__check">
          <input
            type="checkbox"
            ${isChecked ? "checked" : ""}
            data-student-select="${escapeHtml(identity)}"
            aria-label="Seleccionar ${escapeHtml(name)} para grupo"
          />
          <span>Grupo</span>
        </label>
      </div>

      <div class="student-card__body">
        <div class="student-card__top">
          <div class="student-card__identity">
            <h3 class="student-card__name">${escapeHtml(name)}</h3>
            <p class="student-card__document">${escapeHtml(documentValue)}</p>
          </div>

          ${
            uniqueBadges.length
              ? `
            <div class="student-card__badges">
              ${uniqueBadges
                .map((badge) => `<span class="badge">${escapeHtml(String(badge))}</span>`)
                .join("")}
            </div>
          `
              : ""
          }
        </div>

        <div class="student-card__meta">
          <p><strong>Docente:</strong> ${escapeHtml(teacher)}</p>
          <p><strong>Acudiente:</strong> ${escapeHtml(acudiente)}</p>
        </div>
      </div>

      <div class="student-card__actions">
        <button
          type="button"
          class="btn btn--ghost btn--sm"
          data-student-action="details"
        >
          Ver ficha
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

function renderLoadingState() {
  return `
    <div class="empty-state empty-state--loading">
      <p class="empty-state__title">Cargando estudiantes</p>
      <p class="empty-state__text">
        Espera un momento mientras llega la información.
      </p>
    </div>
  `;
}

function renderEmptyResultsState(state) {
  const query = String(state?.search?.query || "").trim();

  if (!query) {
    return `
          <div class="empty-state">
            <p class="empty-state__title">Empieza a buscar</p>
            <p class="empty-state__text">
              Escribe al menos 2 letras para mostrar resultados y mantener la
              pantalla clara desde el primer toque.
            </p>
          </div>
    `;
  }

  if (query.length < 2) {
    return `
      <div class="empty-state">
        <p class="empty-state__title">Falta un poco más</p>
        <p class="empty-state__text">
          Escribe al menos 2 letras para mostrar coincidencias.
        </p>
      </div>
    `;
  }

  if (query) {
    return `
      <div class="empty-state">
        <p class="empty-state__title">Sin resultados</p>
        <p class="empty-state__text">
          No encontramos coincidencias para <strong>${escapeHtml(query)}</strong>.
        </p>
      </div>
    `;
  }

  return "";

  return `
    <div class="empty-state">
      <p class="empty-state__title">Sin estudiantes</p>
      <p class="empty-state__text">
        Todavía no hay registros para mostrar en esta vista.
      </p>
    </div>
  `;
}

function renderDetailItem(label, value) {
  return `
    <div class="student-modal__item">
      <dt class="student-modal__label">${escapeHtml(label)}</dt>
      <dd class="student-modal__value">${escapeHtml(getReadableValue(value))}</dd>
    </div>
  `;
}

function renderBadge(value) {
  if (!value) return "";
  return `<span class="badge">${escapeHtml(String(value))}</span>`;
}

async function safeLoadStudents() {
  const response = await getStudents({
    includeInactive: true,
    estado: "todos",
  });
  const students = normalizeStudentsResponse(response);

  return students.sort((a, b) =>
    getStudentName(a).localeCompare(getStudentName(b), "es", {
      sensitivity: "base",
    })
  );
}

function normalizeStudentsResponse(response) {
  if (Array.isArray(response)) {
    return response.map(normalizeStudent).filter(Boolean);
  }

  if (Array.isArray(response?.data)) {
    return response.data.map(normalizeStudent).filter(Boolean);
  }

  if (Array.isArray(response?.students)) {
    return response.students.map(normalizeStudent).filter(Boolean);
  }

  return [];
}

function normalizeStudent(student) {
  if (!student || typeof student !== "object") return null;

  const processes = Array.isArray(student.processes) ? student.processes : [];
  const firstProcess = processes[0] || null;

  const rawId =
    student.id ||
    student.studentId ||
    student.studentKey ||
    student.ID ||
    student.documento ||
    student.identificacion ||
    student.cc ||
    student.sourceRow ||
    null;

  const safeId = rawId ? String(rawId) : null;
  if (!safeId) return null;

  const safeStudentKey = String(student.studentKey || safeId);

  return {
    ...student,
    id: safeId,
    studentId: safeId,
    studentKey: safeStudentKey,
    nombre: getStudentName(student),
    documento: getStudentDocument(student),
    area: student.area || firstProcess?.arte || "",
    programa: student.programa || firstProcess?.label || "",
    instrumento: student.instrumento || firstProcess?.detalle || "",
    modalidad: student.modalidad || "",
    sede: student.sede || "",
    docente: student.docente || student.teacher || "",
    acudiente: student.acudiente || student.responsable || "",
    processes,
  };
}

function filterStudents(students, query) {
  if (!Array.isArray(students)) return [];

  const rawQuery = String(query || "").trim();
  const normalizedQuery = normalizeText(rawQuery);
  if (!normalizedQuery || rawQuery.length < 2) return [];

  return students
    .filter((student) => {
      const processStrings = Array.isArray(student.processes)
        ? student.processes.flatMap((process) => [
            process?.arte,
            process?.detalle,
            process?.label,
          ])
        : [];

      const searchable = [
        student.id,
        student.studentKey,
        student.nombre,
        student.name,
        student.estudiante,
        student.documento,
        student.identificacion,
        student.cc,
        student.docente,
        student.teacher,
        student.acudiente,
        student.responsable,
        student.modalidad,
        student.area,
        student.programa,
        student.instrumento,
        student.sede,
        student.correo,
        student.email,
        student.telefono,
        student.estado,
        student.interesesMusicales,
        ...processStrings,
      ]
        .filter(Boolean)
        .map((value) => normalizeText(value))
        .join(" ");

      return searchable.includes(normalizedQuery);
    })
    .slice(0, 12);
}

function syncSelectedStudentFromId(studentId, baseState) {
  const safeId = toStringSafe(studentId);
  if (!safeId) return;

  const state = baseState || getState();
  const student =
    state?.students?.byId?.[safeId] ||
    findStudentInCollection(state?.search?.results, safeId) ||
    findStudentInCollection(Object.values(state?.students?.byId || {}), safeId) ||
    null;

  if (student) {
    setSelectedStudent(student);
  }
}

function findStudentInCollection(collection, studentId) {
  if (!Array.isArray(collection)) return null;
  return collection.find((item) => matchesStudentRef(item, studentId)) || null;
}

function getStudentById(studentId) {
  const safeId = toStringSafe(studentId);
  if (!safeId) return null;

  const state = getState();

  return (
    state?.students?.byId?.[safeId] ||
    findStudentInCollection(state?.search?.results, safeId) ||
    findStudentInCollection(Object.values(state?.students?.byId || {}), safeId) ||
    null
  );
}

function toggleStudentInGroup(studentId) {
  const safeId = toStringSafe(studentId);
  if (!safeId) return;

  const selectedIds = getSelectedStudentIds();
  if (selectedIds.includes(safeId)) {
    removeSelectedStudentId(safeId);
  } else {
    addSelectedStudentId(safeId);
  }

  clearAppError();
}

function openStudentModal(studentId) {
  currentModalStudentId = toStringSafe(studentId) || null;
  renderStudentModal(getState());
}

function closeStudentModal() {
  currentModalStudentId = null;
  renderStudentModal(getState());
}

function goToProfile(student) {
  if (typeof currentNavigateTo !== "function" || !student) return;

  const identity = getStudentIdentity(student);
  setSelectedStudent(student);

  currentNavigateTo(CONFIG.routes.profile, {
    id: identity,
    studentId: identity,
    studentKey: student.studentKey || identity,
  });
}

function goToEditor(student, extraPayload = {}) {
  if (typeof currentNavigateTo !== "function" || !student) return;

  const identity = getStudentIdentity(student);
  setSelectedStudent(student);

  currentNavigateTo(CONFIG.routes.editor, {
    id: identity,
    studentId: identity,
    studentKey: student.studentKey || identity,
    ...extraPayload,
  });
}

function syncInputValue(state) {
  const input = viewRoot?.querySelector("#student-search-input");
  if (!input) return;

  const nextValue = String(state?.search?.query || "");
  if (input.value !== nextValue) {
    input.value = nextValue;
  }
}

function cleanupView() {
  if (unsubscribeView) {
    unsubscribeView();
    unsubscribeView = null;
  }

  currentModalStudentId = null;
  hasRetriedInitialLoad = false;
  viewRoot = null;
  currentNavigateTo = null;
  currentSubscribe = null;
}

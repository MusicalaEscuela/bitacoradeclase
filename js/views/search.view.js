import { CONFIG } from "../config.js";
import { resolveUserAccess } from "../authz.js";
import {
  getState,
  patchSlice,
  setAppError,
  clearAppError,
  setSearchResults,
  setFilteredStudentIds,
  setSelectedStudent,
  addSelectedStudentId,
  removeSelectedStudentId,
  clearSelectedStudentIds,
  setStudentsList,
  setStudentsLoading,
  getSelectedStudentIds,
} from "../state.js";
import { getStudents } from "../api/students.api.js?v=20260713.3";
import { getBitacorasByStudentIds } from "../api/bitacoras.api.js?v=20260713.3";
import {
  getCachedStudentIdentityLinkRecords,
  listStudentIdentityLinkRecords,
  manageStudentIdentityLink,
  maskStudentIdentityId,
} from "../api/identity-links.api.js?v=20260713.3";
import {
  escapeHtml,
  getReadableValue,
  getStudentDocument,
  getStudentCondition,
  getStudentIdentity,
  getStudentName,
  getStudentProcessesSummary,
  matchesFlexibleSearch,
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
let currentCanUseHub = false;
let hasRetriedInitialLoad = false;
let searchInputDebounceTimer = null;
let currentIdentityLinkStudentId = null;
let identityLinkSelection = null;
let identityLinkCounts = new Map();
let identityLinkBusy = false;
let identityTrayOpen = false;

const SEARCH_INPUT_DEBOUNCE_MS = 120;

export async function beforeEnter({ payload } = {}) {
  clearAppError();
  if (!canUseTeacherHub(getState()?.auth?.user)) return;
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

  currentCanUseHub = canUseTeacherHub(safeState?.auth?.user);
  root.innerHTML = buildSearchViewMarkup(safeState, safeConfig);

  bindViewEvents();
  renderSummary(getState(), safeConfig);
  renderResults(getState());
  renderIdentityReviewSummary(getState());
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
      const canUseHub = canUseTeacherHub(safeNextState?.auth?.user);

      if (canUseHub !== currentCanUseHub) {
        currentCanUseHub = canUseHub;
        viewRoot.innerHTML = buildSearchViewMarkup(safeNextState, safeConfig);
        bindViewEvents();
      }

      if (authReady && canUseHub && !hasStudents && !isLoading && !hasRetriedInitialLoad) {
        hasRetriedInitialLoad = true;
        refreshStudents().catch((error) => {
          console.error("Error reintentando carga inicial de estudiantes:", error);
        });
      }

      renderSummary(safeNextState, safeConfig);
      renderResults(safeNextState);
      renderIdentityReviewSummary(safeNextState);
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
    setFilteredStudentIds(
      filterStudentIds(visibleStudents, state?.search?.query || "")
    );
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
    setFilteredStudentIds(filterStudentIds(visibleStudents, query));
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
  if (access.role !== CONFIG.roles.admin && access.role !== CONFIG.roles.teacher) {
    return [];
  }

  return students;
}

function buildSearchViewMarkup(state, config) {
  const query = escapeHtml(state?.search?.query || "");
  const canUseHub = canUseTeacherHub(state?.auth?.user);
  const title =
    config?.app?.name ||
    config?.appName ||
    config?.title ||
    "Bitácoras de Clase";

  if (!canUseHub) {
    return `
      <section class="view-shell view-shell--search">
        <header class="view-header">
          <div class="view-header__content">
            <p class="view-eyebrow">${escapeHtml(title)}</p>
            <h1 class="view-title">Ingreso a HUB Docentes Musicala</h1>
            <p class="view-description">
              Para este HUB solo pueden ingresar Admin y Docentes.
            </p>
          </div>
        </header>

        <section class="empty-state">
          <p class="empty-state__title">Inicia sesion con Google</p>
          <p class="empty-state__text">
            Este espacio es interno para busqueda, perfiles y bitacoras pedagogicas.
          </p>
          <button type="button" class="btn btn--primary" data-action="login-google">
            Entrar con Google
          </button>
        </section>
      </section>
    `;
  }

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
      </section>

      ${
        resolveUserAccess(state?.auth?.user).role === CONFIG.roles.admin
          ? `
        <section class="panel identity-review-panel" aria-label="Revisión administrativa de identidad">
          <div>
            <p class="panel-header__eyebrow">Identidad administrativa</p>
            <p id="identity-review-summary" class="search-summary__text">
              Calculando expedientes pendientes…
            </p>
          </div>
          <button type="button" id="identity-review-open-btn" class="btn btn--secondary btn--sm">
            Abrir bandeja de identidad
          </button>
        </section>
      `
          : ""
      }

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

function canUseTeacherHub(user) {
  const access = resolveUserAccess(user);
  return access.role === CONFIG.roles.admin || access.role === CONFIG.roles.teacher;
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
  const identityReviewBtn = viewRoot.querySelector("#identity-review-open-btn");

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

  if (identityReviewBtn) {
    identityReviewBtn.addEventListener("click", openIdentityReviewTray);
  }

  if (resultsContainer) {
    resultsContainer.addEventListener("click", handleResultsClick);
    resultsContainer.addEventListener("keydown", handleResultsKeydown);
    resultsContainer.addEventListener("change", handleSelectionCheckboxChange);
  }

  if (modalRoot) {
    modalRoot.addEventListener("click", handleModalClick);
    modalRoot.addEventListener("change", handleIdentityModalChange);
  }
}

function handleSearchInput(event) {
  const query = String(event?.target?.value || "");
  const state = getState();
  const students = Array.isArray(state?.search?.results)
    ? state.search.results
    : [];

  if (searchInputDebounceTimer) {
    clearTimeout(searchInputDebounceTimer);
  }

  searchInputDebounceTimer = setTimeout(() => {
    applySearchQuery(query, students);
    searchInputDebounceTimer = null;
  }, SEARCH_INPUT_DEBOUNCE_MS);
}

function handleClearSearch() {
  if (searchInputDebounceTimer) {
    clearTimeout(searchInputDebounceTimer);
    searchInputDebounceTimer = null;
  }

  patchSlice("search", {
    query: "",
    filteredIds: [],
    lastSearchAt: Date.now(),
  });

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

  // Los docentes pidieron poder abrir la bitácora grupal directamente y buscar
  // los estudiantes dentro del editor. Si hay menos de dos seleccionados, se abre
  // un grupo "en blanco" (con un estudiante principal sintético) en lugar de
  // bloquear con un error: los integrantes preseleccionados (si los hay) se
  // conservan y el resto se agrega desde el buscador interno del editor.
  if (selectedIds.length < 2) {
    clearAppError();
    openBlankGroupEditor();
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

// Mantener sincronizado con GROUP_PLACEHOLDER_ID en editor.view.js.
const GROUP_PLACEHOLDER_ID = "__nuevo_grupo__";

// Abre el editor de bitácora grupal "en blanco". Se navega directamente con el
// id sintético (sin setSelectedStudent) para no inyectar un estudiante falso en
// el listado/estado de estudiantes. El editor reconoce este id y se renderiza
// sin estudiante principal; los integrantes preseleccionados (si los hay) se
// conservan desde state.search.selectedStudentIds.
function openBlankGroupEditor() {
  if (typeof currentNavigateTo !== "function") return;
  currentNavigateTo(CONFIG.routes.editor, {
    id: GROUP_PLACEHOLDER_ID,
    studentId: GROUP_PLACEHOLDER_ID,
    studentKey: GROUP_PLACEHOLDER_ID,
    mode: CONFIG.modes.group,
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

  const action = actionButton?.dataset?.studentAction || "details";
  if (action === "identity-link") {
    openIdentityLinkModal(student);
    return;
  }

  setSelectedStudent(student);

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
  if (
    event.target.closest("input, select, label") &&
    !event.target.closest("[data-modal-action]")
  ) {
    return;
  }
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
  if (action === "identity-open") {
    const student = getStudentById(actionButton.dataset.studentId);
    if (student) openIdentityLinkModal(student);
    return;
  }
  if (action === "identity-confirm" || action === "identity-reject") {
    handleIdentityDecision(action === "identity-confirm" ? "confirm" : "reject");
    return;
  }
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

  if (identityTrayOpen) {
    renderIdentityTrayModal(modalRoot, state);
    return;
  }

  if (currentIdentityLinkStudentId) {
    renderIdentityLinkModal(modalRoot);
    return;
  }

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
          ${renderDetailItem("Condición", getReadableValue(getStudentCondition(student), "Sin condición registrada"))}
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
  const canManageIdentity =
    resolveUserAccess(getState()?.auth?.user).role === CONFIG.roles.admin &&
    student.identityResolutionStatus === "pending";

  const processBadges = Array.isArray(student.processes)
    ? student.processes
        .map((item) => item.arte || item.label || item.detalle)
        .filter(Boolean)
        .slice(0, 3)
    : [];

  const badges = [
    student.identityResolutionStatus === "pending"
      ? "Revisión de identidad pendiente"
      : "",
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
        ${
          canManageIdentity
            ? `
        <button
          type="button"
          class="btn btn--secondary btn--sm"
          data-student-action="identity-link"
        >
          Vincular expediente histórico
        </button>`
            : ""
        }
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
      ];

      return matchesFlexibleSearch(searchable, normalizedQuery);
    })
    .slice(0, 12);
}

function filterStudentIds(students, query) {
  return filterStudents(students, query)
    .map((student) => getStudentIdentity(student))
    .filter(Boolean);
}

function applySearchQuery(query, students) {
  patchSlice("search", {
    query: String(query || ""),
    filteredIds: filterStudentIds(students, query),
    lastSearchAt: Date.now(),
  });
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

function pendingIdentityStudents(state = getState()) {
  const students = Array.isArray(state?.search?.results)
    ? state.search.results
    : [];
  const unique = new Map();
  students
    .filter((student) => student?.identityResolutionStatus === "pending")
    .forEach((student) => {
      const key =
        toStringSafe(student.identityResolutionSuggestionKey) ||
        candidateIds(student).sort().join("|") ||
        getStudentIdentity(student);
      const current = unique.get(key);
      if (!current || (/^stu_/i.test(current.id) && !/^stu_/i.test(student.id))) {
        unique.set(key, student);
      }
    });
  return [...unique.values()];
}

function renderIdentityReviewSummary(state = getState()) {
  const node = viewRoot?.querySelector("#identity-review-summary");
  if (!node) return;
  const pending = pendingIdentityStudents(state).length;
  const records = getCachedStudentIdentityLinkRecords();
  const confirmed = records.filter((item) => item.status === "confirmed").length;
  const rejected = records.filter((item) => item.status === "rejected").length;
  node.textContent = `${pending} pendientes · ${confirmed} confirmados · ${rejected} rechazados`;
}

function identityCandidates(student) {
  return Array.isArray(student?.identityResolutionCandidates)
    ? student.identityResolutionCandidates.filter((item) => item?.id)
    : [];
}

function candidateIds(student) {
  return identityCandidates(student).map((item) => toStringSafe(item.id)).filter(Boolean);
}

function countLogsForId(id) {
  return Number(identityLinkCounts.get(toStringSafe(id)) || 0);
}

async function loadIdentityLogCounts(students) {
  const ids = [...new Set(students.flatMap(candidateIds))];
  if (!ids.length) return;
  const logs = await getBitacorasByStudentIds(ids, { limit: 0 });
  const counts = new Map(ids.map((id) => [id, 0]));
  logs.forEach((log) => {
    const refs = [...new Set([
      log.studentId,
      ...(Array.isArray(log.studentIds) ? log.studentIds : []),
    ].map(toStringSafe).filter(Boolean))];
    refs.forEach((id) => {
      if (counts.has(id)) counts.set(id, counts.get(id) + 1);
    });
  });
  identityLinkCounts = counts;
}

async function openIdentityReviewTray() {
  if (resolveUserAccess(getState()?.auth?.user).role !== CONFIG.roles.admin) return;
  identityTrayOpen = true;
  currentIdentityLinkStudentId = null;
  renderStudentModal(getState());
  try {
    await Promise.all([
      listStudentIdentityLinkRecords({ includeReviews: true }),
      loadIdentityLogCounts(pendingIdentityStudents()),
    ]);
  } catch (error) {
    console.error("No se pudo cargar la bandeja de identidad:", error);
    setAppError(error?.message || "No se pudo cargar la bandeja de identidad.");
  }
  renderIdentityReviewSummary(getState());
  renderStudentModal(getState());
}

function renderIdentityTrayModal(modalRoot, state) {
  const pending = pendingIdentityStudents(state);
  const records = getCachedStudentIdentityLinkRecords();
  const confirmed = records.filter((item) => item.status === "confirmed");
  const rejected = records.filter((item) => item.status === "rejected");
  const pendingRows = pending.map((student) => {
    const ids = candidateIds(student);
    const totalLogs = ids.reduce((sum, id) => sum + countLogsForId(id), 0);
    return `
      <div class="student-card" role="listitem">
        <div class="student-card__body">
          <strong>${escapeHtml(getStudentName(student))}</strong>
          <p>${ids.map(maskStudentIdentityId).map(escapeHtml).join(" · ")}</p>
          <p>${totalLogs} bitácoras · evidencia media · pendiente</p>
        </div>
        <button type="button" class="btn btn--secondary btn--sm"
          data-modal-action="identity-open"
          data-student-id="${escapeHtml(getStudentIdentity(student))}">
          Comparar y resolver
        </button>
      </div>`;
  }).join("");
  const reviewedRows = [...confirmed, ...rejected].map((record) => `
    <div class="student-card" role="listitem">
      <div class="student-card__body">
        <strong>${record.status === "confirmed" ? "Confirmado" : "Rechazado"}</strong>
        <p>${escapeHtml(maskStudentIdentityId(record.canonicalStudentId))} · ${escapeHtml(maskStudentIdentityId(record.academicRecordId))}</p>
        <p>${escapeHtml(record.linkMethod || "revisión administrativa")}</p>
      </div>
    </div>`).join("");

  modalRoot.classList.remove("is-hidden");
  modalRoot.innerHTML = `
    <div class="student-modal-backdrop" data-modal-close="backdrop">
      <article class="student-modal" role="dialog" aria-modal="true" aria-labelledby="identity-tray-title">
        <header class="student-modal__header">
          <div><p class="student-modal__eyebrow">Administración</p><h3 id="identity-tray-title">Bandeja de identidad</h3></div>
          <button type="button" class="btn btn--ghost btn--sm" data-modal-close="button">Cerrar</button>
        </header>
        <p>${pending.length} pendientes · ${confirmed.length} confirmados · ${rejected.length} rechazados</p>
        <div class="students-results" role="list">${pendingRows || '<p>Sin casos pendientes.</p>'}${reviewedRows}</div>
      </article>
    </div>`;
}

function selectedIdentityCandidates() {
  const student = getStudentById(currentIdentityLinkStudentId);
  const candidates = identityCandidates(student);
  const canonical = candidates.find((item) => item.id === identityLinkSelection?.canonicalStudentId);
  const academic = candidates.find((item) => item.id === identityLinkSelection?.academicRecordId);
  return { student, candidates, canonical, academic };
}

function candidateProcesses(candidate = {}) {
  const values = [candidate.area, candidate.instrumento, candidate.programa];
  if (Array.isArray(candidate.processes)) {
    candidate.processes.forEach((item) => values.push(item?.arte, item?.detalle, item?.label));
  }
  return [...new Set(values.map(toStringSafe).filter(Boolean))].join(" · ") || "No registrado";
}

function candidateDateRange(candidate = {}) {
  return [candidate.createdAt, candidate.updatedAt]
    .map((value) => toStringSafe(value?.toDate?.()?.toISOString?.() || value))
    .filter(Boolean)
    .join(" → ") || "No disponible";
}

function renderCandidateComparison(label, candidate) {
  if (!candidate) return `<div><strong>${label}</strong><p>Selecciona un registro.</p></div>`;
  return `
    <section class="panel">
      <h4>${escapeHtml(label)}</h4>
      <dl class="student-modal__grid">
        ${renderDetailItem("ID", candidate.id)}
        ${renderDetailItem("Nombre", getStudentName(candidate))}
        ${renderDetailItem("Estado", getReadableValue(candidate.estado || candidate.status))}
        ${renderDetailItem("Acudiente", getReadableValue(candidate.acudiente || candidate.responsable))}
        ${renderDetailItem("Áreas e instrumentos", candidateProcesses(candidate))}
        ${renderDetailItem("Bitácoras", String(countLogsForId(candidate.id)))}
        ${renderDetailItem("Fechas disponibles", candidateDateRange(candidate))}
      </dl>
    </section>`;
}

function renderIdentityLinkModal(modalRoot) {
  const { candidates, canonical, academic } = selectedIdentityCandidates();
  if (!candidates.length) {
    currentIdentityLinkStudentId = null;
    renderStudentModal(getState());
    return;
  }
  const canonicalOptions = candidates.filter((item) => !/^stu_/i.test(item.id));
  const academicOptions = candidates.filter((item) => /^stu_/i.test(item.id));
  const option = (item, selected) => `<option value="${escapeHtml(item.id)}" ${item.id === selected ? "selected" : ""}>${escapeHtml(getStudentName(item))} · ${escapeHtml(item.id)}</option>`;
  modalRoot.classList.remove("is-hidden");
  modalRoot.innerHTML = `
    <div class="student-modal-backdrop" data-modal-close="backdrop">
      <article class="student-modal" role="dialog" aria-modal="true" aria-labelledby="identity-link-title">
        <header class="student-modal__header">
          <div><p class="student-modal__eyebrow">Confirmación administrativa</p><h3 id="identity-link-title">Vincular expediente histórico</h3></div>
          <button type="button" class="btn btn--ghost btn--sm" data-modal-close="button">Cerrar</button>
        </header>
        <div class="field"><label>Registro canónico<select id="identity-canonical-select" class="field__input">${canonicalOptions.map((item) => option(item, canonical?.id)).join("")}</select></label></div>
        <div class="field"><label>Registro STU histórico<select id="identity-academic-select" class="field__input">${academicOptions.map((item) => option(item, academic?.id)).join("")}</select></label></div>
        <div class="search-layout">${renderCandidateComparison("Identidad canónica", canonical)}${renderCandidateComparison("Expediente académico", academic)}</div>
        <p class="empty-state__text"><strong>Esta acción vincula los registros para visualización y seguimiento. No elimina ni fusiona documentos.</strong></p>
        <label class="student-card__check"><input id="identity-explicit-confirm" type="checkbox" /> Confirmo que revisé la evidencia y los IDs.</label>
        <div class="student-modal__actions">
          <button type="button" class="btn btn--primary" data-modal-action="identity-confirm" ${identityLinkBusy ? "disabled" : ""}>Confirmar vínculo</button>
          <button type="button" class="btn btn--ghost" data-modal-action="identity-reject" ${identityLinkBusy ? "disabled" : ""}>Rechazar sugerencia</button>
        </div>
      </article>
    </div>`;
}

async function openIdentityLinkModal(student) {
  if (resolveUserAccess(getState()?.auth?.user).role !== CONFIG.roles.admin) return;
  const candidates = identityCandidates(student);
  const canonical = candidates.find((item) => !/^stu_/i.test(item.id));
  const academic = candidates.find((item) => /^stu_/i.test(item.id));
  if (!canonical || !academic) {
    setAppError("El caso no contiene un par canónico/STU válido.");
    return;
  }
  identityTrayOpen = false;
  currentModalStudentId = null;
  currentIdentityLinkStudentId = getStudentIdentity(student);
  identityLinkSelection = {
    canonicalStudentId: canonical.id,
    academicRecordId: academic.id,
  };
  renderStudentModal(getState());
  await loadIdentityLogCounts([student]).catch((error) => {
    console.warn("No se pudieron contar bitácoras para comparar:", error);
  });
  renderStudentModal(getState());
}

function handleIdentityModalChange(event) {
  if (!currentIdentityLinkStudentId) return;
  if (event.target.id === "identity-canonical-select") {
    identityLinkSelection.canonicalStudentId = toStringSafe(event.target.value);
    renderStudentModal(getState());
  } else if (event.target.id === "identity-academic-select") {
    identityLinkSelection.academicRecordId = toStringSafe(event.target.value);
    renderStudentModal(getState());
  }
}

async function handleIdentityDecision(action) {
  if (identityLinkBusy || !identityLinkSelection) return;
  const checked = viewRoot?.querySelector("#identity-explicit-confirm")?.checked === true;
  if (!checked) {
    setAppError("Confirma explícitamente que revisaste la evidencia.");
    return;
  }
  identityLinkBusy = true;
  renderStudentModal(getState());
  try {
    await manageStudentIdentityLink({
      action,
      canonicalStudentId: identityLinkSelection.canonicalStudentId,
      academicRecordId: identityLinkSelection.academicRecordId,
      linkedStudentIds: [
        identityLinkSelection.canonicalStudentId,
        identityLinkSelection.academicRecordId,
      ],
    });
    currentIdentityLinkStudentId = null;
    identityLinkSelection = null;
    await refreshStudents();
    clearAppError();
  } catch (error) {
    console.error("No se pudo resolver el vínculo de identidad:", error);
    setAppError(error?.message || "No se pudo resolver el vínculo de identidad.");
  } finally {
    identityLinkBusy = false;
    renderStudentModal(getState());
  }
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
  currentIdentityLinkStudentId = null;
  identityLinkSelection = null;
  identityTrayOpen = false;
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
  if (searchInputDebounceTimer) {
    clearTimeout(searchInputDebounceTimer);
    searchInputDebounceTimer = null;
  }

  currentModalStudentId = null;
  hasRetriedInitialLoad = false;
  viewRoot = null;
  currentNavigateTo = null;
  currentSubscribe = null;
}

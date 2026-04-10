// js/views/editor.view.js

import { CONFIG, canUseGroupBitacoras } from "../config.js";
import { canViewStudent, resolveUserAccess } from "../authz.js";
import {
  getState,
  getSelectedStudentId,
  getSelectedStudentBitacoras,
  getCurrentDraft,
  setCurrentView,
  setAppError,
  clearAppError,
  setAppSaving,
  setBitacorasLoading,
  setBitacorasForStudent,
  addBitacoraForStudent,
  updateDraft,
  resetDraft,
  setUploadQueue,
  clearUploads,
} from "../state.js";

import {
  getBitacorasByStudent,
  createBitacora,
} from "../api/bitacoras.api.js";

import {
  getCatalogs,
  getEmptyCatalogs,
} from "../api/catalogs.api.js";

import {
  escapeHtml,
  firstNonEmpty,
  formatDisplayDate,
  getReadableValue,
  getStudentDocument,
  getStudentFallbackId,
  getStudentIdentity,
  getStudentName,
  getStudentProcessesSummary,
  getTimestamp,
  getTodayDate,
  isPlainObject,
  normalizeBitacorasResponse as normalizeBitacorasResponseShared,
  normalizeText,
  normalizeMode,
  normalizeStudentIds,
  normalizeStudentRefs,
  resolveStudentRefFromPayload,
  findStudentInCollections,
  toStringSafe,
} from "../utils/shared.js";

let viewRoot = null;
let unsubscribeView = null;
let currentNavigateTo = null;
let currentSubscribe = null;
let currentEditorStudentKey = null;
let currentEditorMode = CONFIG?.modes?.individual || "individual";
let cachedCatalogs = getEmptyCatalogs();
let catalogsLoadAttempted = false;

export async function beforeEnter({ payload, navigateTo } = {}) {
  clearAppError();

  const state = getState();
  const access = resolveUserAccess(state?.auth?.user);
  const requestedStudentRef =
    access.role === CONFIG.roles.student
      ? access.linkedStudentId
      : resolveStudentRefFromPayload(payload);
  const requestedMode = getRequestedModeFromPayload(payload);
  const student = getStudentFromState(state, requestedStudentRef);

  if (!student || !canViewStudent(state?.auth?.user, getStudentIdentity(student))) {
    setAppError("No hay un estudiante seleccionado.");
    if (typeof navigateTo === "function") {
      navigateTo(
        access.role === CONFIG.roles.student
          ? CONFIG.routes.profile
          : CONFIG.routes.search
      );
    }
    return;
  }

  currentEditorStudentKey = getStudentIdentity(student);

  await ensureCatalogsLoaded();
  await ensureBitacorasLoaded(student);

  const draft = getCurrentDraft();

  if (!draftBelongsToContext(draft, student)) {
    resetDraftForContext({
      mode: requestedMode || CONFIG.modes.individual,
      student,
    });
    return;
  }

  if (requestedMode && normalizeMode(draft?.mode) !== requestedMode) {
    const nextDraft = buildDraftWithMode({
      draft,
      student,
      mode: requestedMode,
      allStudents: getAllStudentsFromState(getState()),
    });

    updateDraft(nextDraft);
    currentEditorMode = nextDraft.mode;
  }
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
  const access = resolveUserAccess(safeState?.auth?.user);
  const requestedStudentRef =
    access.role === CONFIG.roles.student
      ? access.linkedStudentId
      : resolveStudentRefFromPayload(payload);
  const student = getStudentFromState(safeState, requestedStudentRef);

  if (!student || !canViewStudent(safeState?.auth?.user, getStudentIdentity(student))) {
    root.innerHTML = renderMissingStudent();
    bindMissingStateEvents();
    setupSubscription(safeConfig, requestedStudentRef);
    return;
  }

  currentEditorStudentKey = getStudentIdentity(student);
  await ensureCatalogsLoaded();

  const draft = getDraftForContext(student);
  currentEditorMode = draft.mode || CONFIG.modes.individual;

  const bitacoras = getBitacorasFromState(student);

  root.innerHTML = buildMusicalaEditorMarkup({
    student,
    draft,
    bitacoras,
    isLoading: Boolean(safeState?.bitacoras?.loading),
    isAuthenticated: Boolean(safeState?.auth?.isAuthenticated),
    canEditBitacoras: access.canEditBitacoras,
    config: safeConfig,
    allStudents: getAllStudentsFromState(safeState),
  });

  bindEditorEvents(student);
  renderReactiveBlocks(getState(), safeConfig, currentEditorStudentKey);
  setupSubscription(safeConfig, currentEditorStudentKey);
}

export async function afterEnter() {
  const tareas = viewRoot?.querySelector("#bitacora-tareas");
  if (tareas) {
    tareas.focus();
    return;
  }

  const fecha = viewRoot?.querySelector("#bitacora-fecha");
  if (fecha) fecha.focus();
}

export function beforeLeave() {
  cleanupView();
}

export function destroy() {
  cleanupView();
}

function setupSubscription(config, preferredStudentRef = null) {
  if (unsubscribeView) {
    unsubscribeView();
    unsubscribeView = null;
  }

  if (typeof currentSubscribe !== "function") return;

  unsubscribeView = currentSubscribe((nextState) => {
    if (!viewRoot || !viewRoot.isConnected) return;

    const state = nextState || getState();
    const student = getStudentFromState(
      state,
      preferredStudentRef || currentEditorStudentKey
    );

    if (!student) {
      viewRoot.innerHTML = renderMissingStudent();
      bindMissingStateEvents();
      return;
    }

    currentEditorStudentKey = getStudentIdentity(student);
    renderReactiveBlocks(state, config, currentEditorStudentKey);
  });
}

async function ensureBitacorasLoaded(student) {
  const studentRef = getStudentIdentity(student);
  if (!studentRef) return;

  const currentItems = getBitacorasFromState(student);
  if (currentItems.length > 0) return;

  setBitacorasLoading(true);

  try {
    const items = await safeLoadBitacoras(studentRef);
    setBitacorasForStudent(studentRef, items);

    const fallbackId = getStudentFallbackId(student);
    if (fallbackId && fallbackId !== studentRef) {
      setBitacorasForStudent(fallbackId, items);
    }
  } catch (error) {
    console.error("Error cargando bitácoras del estudiante:", error);
    setAppError(error?.message || "No se pudieron cargar las bitácoras.");
  } finally {
    setBitacorasLoading(false);
  }
}

function buildEditorMarkup({
  student,
  draft,
  bitacoras,
  isLoading,
  isAuthenticated = false,
  canEditBitacoras = false,
  config,
  allStudents = [],
}) {
  const title =
    config?.app?.name ||
    config?.appName ||
    config?.title ||
    "Bitácoras de Clase";

  const isGroup = draft.mode === CONFIG.modes.group;

  return `
    <section class="view-shell view-shell--editor">
      <header class="view-header">
        <div class="view-header__content">
          <p class="view-eyebrow">${escapeHtml(title)}</p>
          <h1 class="view-title">Editor de bitácora</h1>
          <p class="view-description">
            Registren observaciones, avances, dificultades y acuerdos de clase sin
            poner al docente a sufrir con una interfaz torpe. Qué detalle tan
            revolucionario.
          </p>
        </div>

        <div class="view-header__actions">
          <button
            type="button"
            class="btn btn--ghost"
            id="editor-back-search-btn"
          >
            Volver a búsqueda
          </button>
          <button
            type="button"
            class="btn btn--secondary"
            id="editor-open-profile-btn"
          >
            Ver perfil
          </button>
        </div>
      </header>

      <section class="editor-layout">
        <aside class="card editor-student">
          <header class="panel-header">
          <div>
              <p class="panel-header__eyebrow">Contexto</p>
              <h2 class="panel-header__title">Resumen rápido</h2>
            </div>
          </header>

          <div id="editor-student-summary">
            ${renderStudentSummary(student)}
          </div>
        </aside>

        <main class="editor-main">
          <section class="card editor-form">
            <header class="editor-form__header">
              <div>
                <p class="panel-header__eyebrow">Registro</p>
                <h2 class="panel-header__title">Nueva bitácora</h2>
              </div>
              <p class="section-text">
                El borrador se conserva mientras escriben. Perder texto por un refresh
                sigue siendo una tragedia demasiado común para 2026.
              </p>
              ${
                !isAuthenticated
                  ? `
                    <div class="message-box message-box--warning">
                      Inicia sesiÃ³n con Google para consultar el historial y guardar bitÃ¡coras en Firebase.
                    </div>
                  `
                  : ""
              }
              ${
                isAuthenticated && !canEditBitacoras
                  ? `
                    <div class="message-box message-box--warning">
                      Tu cuenta de estudiante solo puede consultar su bitacora y su ruta. No puede editar registros.
                    </div>
                  `
                  : ""
              }
            </header>

            <form id="bitacora-form" class="bitacora-form" novalidate>
              <div class="form-grid form-grid--modes">
                <fieldset class="field field--radio-group">
                  <legend class="field__label">Tipo de bitácora</legend>

                  <label class="choice-pill">
                    <input
                      type="radio"
                      name="modoBitacora"
                      value="${escapeHtml(CONFIG.modes.individual)}"
                      ${!isGroup ? "checked" : ""}
                    />
                    <span>Individual</span>
                  </label>

                  ${
                    canUseGroupBitacoras()
                      ? `
                        <label class="choice-pill">
                          <input
                            type="radio"
                            name="modoBitacora"
                            value="${escapeHtml(CONFIG.modes.group)}"
                            ${isGroup ? "checked" : ""}
                          />
                          <span>Grupal</span>
                        </label>
                      `
                      : ""
                  }
                </fieldset>

                <label class="field">
                  <span class="field__label">Fecha de clase</span>
                  <input
                    id="bitacora-fecha"
                    name="fechaClase"
                    type="date"
                    class="field__input"
                    value="${escapeHtml(draft.fechaClase || getTodayDate())}"
                  />
                </label>

                <label class="field">
                  <span class="field__label">Título</span>
                  <input
                    id="bitacora-titulo"
                    name="titulo"
                    type="text"
                    class="field__input"
                    placeholder="Ej: Clase de ritmo y coordinación"
                    maxlength="${CONFIG?.limits?.maxTitleLength || 140}"
                    value="${escapeHtml(draft.titulo || "")}"
                  />
                </label>
              </div>

              <section
                class="group-editor ${isGroup ? "" : "is-hidden"}"
                id="group-editor-block"
              >
                <div class="group-editor__header">
                  <div>
                    <p class="panel-header__eyebrow">Clase grupal</p>
                    <h3 class="panel-header__title">Estudiantes incluidos</h3>
                  </div>
                  <p class="section-text">
                    El estudiante actual ya viene seleccionado. Agreguen o quiten los
                    demás sin duplicar bitácoras como si fueran panfletos.
                  </p>
                </div>

                <label class="field">
                  <span class="field__label">Buscar estudiantes para agregar</span>
                  <input
                    id="group-students-search"
                    type="text"
                    class="field__input"
                    placeholder="Buscar por nombre, documento o proceso..."
                    autocomplete="off"
                  />
                </label>

                <div id="group-selected-students" class="group-selected-students">
                  ${renderSelectedStudentsChips(
                    getSelectedStudentsForDraft(draft, student, allStudents)
                  )}
                </div>

                <div id="group-students-results" class="group-students-results">
                  ${renderGroupStudentsResults(
                    allStudents,
                    getSelectedStudentsForDraft(draft, student, allStudents),
                    ""
                  )}
                </div>
              </section>

              <label class="field">
                <span class="field__label">Etiquetas</span>
                <input
                  id="bitacora-etiquetas"
                  name="etiquetas"
                  type="text"
                  class="field__input"
                  placeholder="Ej: ritmo, postura, concentración"
                  value="${escapeHtml(formatTagsForInput(draft.etiquetas || []))}"
                />
                <small class="field__hint">Sepárenlas con coma.</small>
              </label>

              <label class="field">
                <span class="field__label">Contenido</span>
                <textarea
                  id="bitacora-contenido"
                  name="contenido"
                  class="field__textarea"
                  rows="10"
                  maxlength="${CONFIG?.limits?.maxBitacoraLength || 8000}"
                  placeholder="Escriban aquí lo trabajado en clase, observaciones, recomendaciones, acuerdos y evolución del estudiante o grupo."
                >${escapeHtml(draft.contenido || "")}</textarea>
              </label>

              <label class="field">
                <span class="field__label">Archivos de apoyo</span>
                <input
                  id="bitacora-archivos"
                  name="archivos"
                  type="file"
                  class="field__input"
                  multiple
                />
                <small class="field__hint">
                  Pueden adjuntar imágenes, video, audio o PDF. Si el flujo de uploads
                  todavía no está completo, al menos queda registro local en el draft.
                </small>
              </label>

              <div id="bitacora-files-preview" class="files-preview">
                ${renderFilesPreview(draft.archivos || [])}
              </div>

              <div class="editor-form__footer">
                <div class="editor-form__meta" id="editor-form-meta">
                  ${renderDraftMeta(draft, student, allStudents)}
                </div>

                <div class="editor-form__actions">
                  <button
                    type="button"
                    class="btn btn--ghost"
                    id="bitacora-reset-btn"
                  >
                    Limpiar
                  </button>
                  <button
                    type="submit"
                    class="btn btn--primary"
                    id="bitacora-save-btn"
                    ${!isAuthenticated || !canEditBitacoras ? "disabled" : ""}
                  >
                    Guardar bitácora
                  </button>
                </div>
              </div>
            </form>
          </section>

          <section class="card editor-history">
            <header class="editor-history__header">
              <div>
                <p class="panel-header__eyebrow">Historial</p>
                <h2 class="panel-header__title">Bitácoras registradas</h2>
              </div>

              <button
                type="button"
                class="btn btn--ghost btn--sm"
                id="bitacora-refresh-btn"
              >
                Recargar
              </button>
            </header>

            <div id="bitacoras-history">
              ${renderBitacorasHistory(bitacoras, isLoading, config, isAuthenticated)}
            </div>
          </section>
        </main>
      </section>
    </section>
  `;
}

function bindEditorEvents(student) {
  if (!viewRoot) return;

  const form = viewRoot.querySelector("#bitacora-form");
  const fechaInput = viewRoot.querySelector("#bitacora-fecha");
  const tituloInput = viewRoot.querySelector("#bitacora-titulo");
  const docenteInput = viewRoot.querySelector("#bitacora-docente");
  const etiquetasInput = viewRoot.querySelector("#bitacora-etiquetas");
  const tareasInput = viewRoot.querySelector("#bitacora-tareas");
  const corporalInput = viewRoot.querySelector("#bitacora-componente-corporal");
  const tecnicoInput = viewRoot.querySelector("#bitacora-componente-tecnico");
  const teoricoInput = viewRoot.querySelector("#bitacora-componente-teorico");
  const obrasInput = viewRoot.querySelector("#bitacora-componente-obras");
  const contenidoInput = viewRoot.querySelector("#bitacora-contenido");
  const archivosInput = viewRoot.querySelector("#bitacora-archivos");
  const videosInput = viewRoot.querySelector("#bitacora-videos");
  const resetBtn = viewRoot.querySelector("#bitacora-reset-btn");
  const refreshBtn = viewRoot.querySelector("#bitacora-refresh-btn");
  const printBtn = viewRoot.querySelector("#bitacora-print-btn");
  const backSearchBtn = viewRoot.querySelector("#editor-back-search-btn");
  const openProfileBtn = viewRoot.querySelector("#editor-open-profile-btn");
  const modeInputs = viewRoot.querySelectorAll('input[name="modoBitacora"]');
  const groupSearchInput = viewRoot.querySelector("#group-students-search");
  const groupResultsContainer = viewRoot.querySelector("#group-students-results");
  const selectedStudentsContainer = viewRoot.querySelector("#group-selected-students");
  const overridesContainer = viewRoot.querySelector("#student-overrides-block");

  [
    fechaInput,
    tituloInput,
    docenteInput,
    tareasInput,
    contenidoInput,
  ].forEach((input) => {
    if (!input) return;
    input.addEventListener("input", () => handleDraftInput(student));
    input.addEventListener("change", () => handleDraftInput(student));
  });

  modeInputs.forEach((input) => {
    input.addEventListener("change", () => {
      handleModeChange(student, input.value);
    });
  });

  if (groupSearchInput) {
    groupSearchInput.addEventListener("input", () => {
      renderGroupSelectionBlocks(student);
    });
  }

  if (groupResultsContainer) {
    groupResultsContainer.addEventListener("click", (event) => {
      const button = event.target.closest("[data-group-add-student]");
      if (!button) return;

      const studentId = button.getAttribute("data-group-add-student");
      addStudentToGroupDraft(student, studentId);
      renderGroupSelectionBlocks(student);
      renderDraftMetaBlock(student);
    });
  }

  if (selectedStudentsContainer) {
    selectedStudentsContainer.addEventListener("click", (event) => {
      const button = event.target.closest("[data-group-remove-student]");
      if (!button) return;

      const studentId = button.getAttribute("data-group-remove-student");
      removeStudentFromGroupDraft(student, studentId);
      renderGroupSelectionBlocks(student);
      renderDraftMetaBlock(student);
    });
  }

  if (overridesContainer) {
    overridesContainer.addEventListener("change", (event) => {
      const checkbox = event.target.closest("[data-override-enabled]");
      if (checkbox) {
        const studentId = checkbox.getAttribute("data-override-enabled");
        toggleStudentOverride(student, studentId, checkbox.checked);
        return;
      }

      const textarea = event.target.closest("[data-override-textarea]");
      if (textarea) {
        handleDraftInput(student);
        return;
      }

      const input = event.target.closest("[data-override-input]");
      if (!input) return;

      const options = getDatalistOptions(input.getAttribute("list"));
      if (matchesCatalogOption(input.value, options)) {
        addStudentOverrideValue(
          input.getAttribute("data-override-input"),
          input.value,
          student
        );
      }
    });

    overridesContainer.addEventListener("input", (event) => {
      const textarea = event.target.closest("[data-override-textarea]");
      if (textarea) {
        handleDraftInput(student);
        return;
      }

      const input = event.target.closest("[data-override-input]");
      if (!input) return;

      const options = getDatalistOptions(input.getAttribute("list"));
      if (matchesCatalogOption(input.value, options)) {
        addStudentOverrideValue(
          input.getAttribute("data-override-input"),
          input.value,
          student
        );
      }
    });

    overridesContainer.addEventListener("keydown", (event) => {
      const input = event.target.closest("[data-override-input]");
      if (!input) return;

      if (event.key === "Enter" || event.key === ",") {
        event.preventDefault();
        addStudentOverrideValue(input.getAttribute("data-override-input"), input.value, student);
      }
    });

    overridesContainer.addEventListener("click", (event) => {
      const removeButton = event.target.closest("[data-override-remove]");
      if (removeButton) {
        removeStudentOverrideValue(
          {
            studentId: removeButton.getAttribute("data-override-student"),
            key: removeButton.getAttribute("data-override-key"),
            value: removeButton.getAttribute("data-override-value"),
          },
          student
        );
      }
    });
  }

  if (archivosInput) {
    archivosInput.addEventListener("change", (event) =>
      handleFilesChange(event, student, "support")
    );
  }

  const multiInputKeys = [
    "etiquetas",
    "componenteCorporal",
    "componenteTecnico",
    "componenteTeorico",
    "componenteObras",
  ];

  multiInputKeys.forEach((key) => {
    const input = viewRoot.querySelector(`[data-multi-input="${key}"]`);
    if (!input) return;

    input.addEventListener("input", () => {
      const options = getDatalistOptions(input.getAttribute("list"));
      if (matchesCatalogOption(input.value, options)) {
        addMultiValueSelection(key, input.value, student);
      }
    });

    input.addEventListener("change", () => {
      const options = getDatalistOptions(input.getAttribute("list"));
      if (matchesCatalogOption(input.value, options)) {
        addMultiValueSelection(key, input.value, student);
      }
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === ",") {
        event.preventDefault();
        addMultiValueSelection(key, input.value, student);
      }
    });
  });

  viewRoot.querySelectorAll("[data-multi-values]").forEach((container) => {
    container.addEventListener("click", (event) => {
      const button = event.target.closest("[data-multi-remove]");
      if (!button) return;

      const key = button.getAttribute("data-multi-key");
      const value = button.getAttribute("data-multi-remove");
      if (!key || !value) return;

      removeMultiValueSelection(key, value, student);
    });
  });

  if (videosInput) {
    videosInput.addEventListener("change", (event) =>
      handleFilesChange(event, student, "video")
    );
  }

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      resetDraftForContext({
        mode: currentEditorMode || CONFIG.modes.individual,
        student,
      });
      refillFormFromDraft(student);
      renderGroupSelectionBlocks(student);
      renderFilesPreviewBlock(student);
      renderDraftMetaBlock(student);
      syncModeInputs();
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      await reloadHistory(student);
    });
  }

  if (printBtn) {
    printBtn.addEventListener("click", () => {
      handlePrintHistory(student);
    });
  }

  if (backSearchBtn) {
    backSearchBtn.addEventListener("click", () => {
      goToSearch();
    });
  }

  if (openProfileBtn) {
    openProfileBtn.addEventListener("click", () => {
      goToProfile(student);
    });
  }

  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await handleSubmit(student);
    });
  }
}

function bindMissingStateEvents() {
  if (!viewRoot) return;

  const backBtn = viewRoot.querySelector("#editor-missing-back-btn");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      goToSearch();
    });
  }
}

function renderReactiveBlocks(state, config, preferredStudentRef = null) {
  const student = getStudentFromState(
    state,
    preferredStudentRef || currentEditorStudentKey
  );

  if (!student || !viewRoot) return;

  const studentContainer = viewRoot.querySelector("#editor-student-summary");
  const historyContainer = viewRoot.querySelector("#bitacoras-history");

  if (studentContainer) {
    studentContainer.innerHTML = renderStudentSummaryCompact(student);
  }

  if (historyContainer) {
    historyContainer.innerHTML = renderBitacorasHistory(
      getBitacorasFromState(student),
      Boolean(state?.bitacoras?.loading),
      config
    );
  }

  refillFormIfNeeded(student);
  renderGroupSelectionBlocks(student);
  renderStudentOverridesBlock(student);
  renderFilesPreviewBlock(student);
  renderDraftMetaBlock(student);
  syncModeInputs();
}

function handleDraftInput(student) {
  const draft = updateDraftFromForm(student);
  renderDraftMetaBlock(student);
  return draft;
}

function handleModeChange(student, mode) {
  const safeMode = getAllowedMode(mode);
  currentEditorMode = safeMode;

  const currentDraft = getDraftForContext(student);
  const nextDraft = buildDraftWithMode({
    draft: currentDraft,
    student,
    mode: safeMode,
    allStudents: getAllStudentsFromState(getState()),
  });

  updateDraft(nextDraft);

  toggleGroupModeBlock(safeMode === CONFIG.modes.group);
  renderGroupSelectionBlocks(student);
  renderDraftMetaBlock(student);
}

function handleFilesChange(event, student, kind = "support") {
  const files = Array.from(event?.target?.files || []);
  const studentRef = getStudentIdentity(student);

  setUploadQueue(files);

  const currentDraft = getDraftForContext(student);
  const existingFiles = Array.isArray(currentDraft.archivos)
    ? currentDraft.archivos.filter((file) => (file.kind || "support") !== kind)
    : [];

  updateDraft({
    ...currentDraft,
    studentId: studentRef,
    studentKey: student.studentKey || studentRef,
    archivos: [...existingFiles, ...files.map((file) => mapFileToDraftItem(file, kind))],
  });

  renderFilesPreviewBlock(student);
  renderDraftMetaBlock(student);
}

function refillFormIfNeeded(student) {
  const draft = getDraftForContext(student);
  const structured = getStructuredDraftFields(draft, student);

  syncInputValue("#bitacora-fecha", draft.fechaClase || getTodayDate());
  syncInputValue("#bitacora-titulo", draft.titulo || buildAutoTitle(student, draft.fechaClase));
  syncInputValue("#bitacora-docente", structured.docente || "");
  syncTextareaValue("#bitacora-tareas", structured.tareas || "");
  syncTextareaValue("#bitacora-contenido", draft.contenido || "");
  syncInputValue("#bitacora-etiquetas-input", "");
  syncInputValue("#bitacora-componente-corporal-input", "");
  syncInputValue("#bitacora-componente-tecnico-input", "");
  syncInputValue("#bitacora-componente-teorico-input", "");
  syncInputValue("#bitacora-componente-obras-input", "");
  renderMultiValueSelection("etiquetas", draft.etiquetas || []);
  renderMultiValueSelection("componenteCorporal", structured.componenteCorporal || []);
  renderMultiValueSelection("componenteTecnico", structured.componenteTecnico || []);
  renderMultiValueSelection("componenteTeorico", structured.componenteTeorico || []);
  renderMultiValueSelection("componenteObras", structured.componenteObras || []);
  renderStudentOverridesBlock(student);
}

function refillFormFromDraft(student) {
  refillFormIfNeeded(student);
}

function getMultiValueSelection(key) {
  const container = viewRoot?.querySelector(`[data-multi-values="${key}"]`);
  if (!container) return [];

  return [...container.querySelectorAll("[data-multi-item]")]
    .map((item) => toStringSafe(item.getAttribute("data-multi-item")))
    .filter(Boolean);
}

function getOverrideMultiValueSelection(studentId, key) {
  const container = viewRoot?.querySelector(
    `[data-override-values="${studentId}:${key}"]`
  );
  if (!container) return [];

  return [...container.querySelectorAll("[data-override-item]")]
    .map((item) => toStringSafe(item.getAttribute("data-override-item")))
    .filter(Boolean);
}

function renderMultiValueSelection(key, values = []) {
  const container = viewRoot?.querySelector(`[data-multi-values="${key}"]`);
  if (!container) return;

  container.innerHTML = renderMultiValueChips(key, values);
}

function addMultiValueSelection(key, rawValue, student) {
  const input = viewRoot?.querySelector(`[data-multi-input="${key}"]`);
  const valuesToAdd = normalizeListValues(rawValue);
  if (!valuesToAdd.length) return;

  const nextValues = normalizeListValues([
    ...getMultiValueSelection(key),
    ...valuesToAdd,
  ]);

  renderMultiValueSelection(key, nextValues);
  if (input) input.value = "";
  handleDraftInput(student);
}

function getDatalistOptions(listId) {
  const safeId = toStringSafe(listId);
  if (!safeId || !viewRoot) return [];

  const datalist = viewRoot.querySelector(`#${CSS.escape(safeId)}`);
  if (!datalist) return [];

  return [...datalist.querySelectorAll("option")]
    .map((option) => toStringSafe(option.value))
    .filter(Boolean);
}

function matchesCatalogOption(rawValue, options = []) {
  const candidate = normalizeText(rawValue);
  if (!candidate) return false;

  return options.some((option) => normalizeText(option) === candidate);
}

function removeMultiValueSelection(key, value, student) {
  const nextValues = getMultiValueSelection(key).filter((item) => item !== value);
  renderMultiValueSelection(key, nextValues);
  handleDraftInput(student);
}

async function handleSubmit(student) {
  clearAppError();
  const access = resolveUserAccess(getState()?.auth?.user);

  if (!access.canEditBitacoras) {
    setAppError("Tu cuenta no tiene permisos para editar bitacoras.");
    return;
  }

  const studentRef = getStudentIdentity(student);
  if (!studentRef) {
    setAppError("No hay estudiante seleccionado.");
    setCurrentView(CONFIG.routes.search);
    goToSearch();
    return;
  }

  const draft = updateDraftFromForm(student);
  const validation = validateDraft(draft, student);

  if (!validation.valid) {
    setAppError(validation.message);
    return;
  }

  setAppSaving(true);

  try {
    const payload = buildBitacoraPayload(student, draft);
    const created = await createBitacora(payload);
    const normalized = normalizeCreatedBitacora(created, payload);

    const relatedStudentIds = Array.isArray(normalized.studentIds)
      ? normalized.studentIds
      : [studentRef];

    relatedStudentIds.forEach((id) => {
      if (!id) return;
      addBitacoraForStudent(id, normalized);
    });

    const fallbackId = getStudentFallbackId(student);
    if (fallbackId && !relatedStudentIds.includes(fallbackId)) {
      addBitacoraForStudent(fallbackId, normalized);
    }

    resetDraftForContext({
      mode: draft.mode || CONFIG.modes.individual,
      student,
    });

    refillFormFromDraft(student);
    renderGroupSelectionBlocks(student);
    renderFilesPreviewBlock(student);
    renderDraftMetaBlock(student);
    syncModeInputs();
  } catch (error) {
    console.error("Error guardando bitácora:", error);
    setAppError(
      error?.message ||
        CONFIG?.text?.saveError ||
        "No se pudo guardar la bitácora."
    );
  } finally {
    setAppSaving(false);
  }
}

async function reloadHistory(student) {
  const studentRef = getStudentIdentity(student);
  if (!studentRef) return;

  setBitacorasLoading(true);

  try {
    clearAppError();
    const items = await safeLoadBitacoras(studentRef);
    setBitacorasForStudent(studentRef, items);

    const fallbackId = getStudentFallbackId(student);
    if (fallbackId && fallbackId !== studentRef) {
      setBitacorasForStudent(fallbackId, items);
    }
  } catch (error) {
    console.error("Error recargando historial:", error);
    setAppError(error?.message || "No se pudo recargar el historial.");
  } finally {
    setBitacorasLoading(false);
  }
}

function handlePrintHistory(student) {
  const items = getBitacorasFromState(student);
  if (!Array.isArray(items) || !items.length) {
    setAppError("No hay bitacoras para imprimir.");
    return;
  }

  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    setAppError("No se pudo abrir la ventana de impresion. Revisa si el navegador bloqueo la ventana emergente.");
    return;
  }

  const sortedItems = sortBitacorasByDate(items);
  const html = buildHistoryPrintDocument(student, sortedItems);

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.focus();
}

function buildHistoryPrintDocument(student, items = []) {
  const studentName = getStudentName(student);
  const studentDocument = getStudentDocument(student) || "Sin documento";
  const processSummary = getReadableValue(
    getStudentProcessesSummary(student),
    "Sin proceso registrado"
  );
  const printedAt = formatDisplayDate(new Date().toISOString());

  return `
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <title>Historial de bitacoras - ${escapeHtml(studentName)}</title>
        <style>
          :root {
            color-scheme: light;
            --ink: #1f3147;
            --muted: #64748b;
            --line: #d7e1ec;
            --panel: #f8fbfd;
            --accent: #d88c2f;
            --accent-soft: rgba(216, 140, 47, 0.14);
            --blue-soft: rgba(29, 79, 145, 0.08);
          }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
            color: var(--ink);
            background: white;
          }
          .sheet {
            width: 100%;
            max-width: 960px;
            margin: 0 auto;
            padding: 32px 40px 48px;
          }
          .report-header {
            border-bottom: 2px solid var(--line);
            padding-bottom: 20px;
            margin-bottom: 24px;
          }
          .report-kicker {
            margin: 0 0 8px;
            font-size: 12px;
            letter-spacing: 0.14em;
            text-transform: uppercase;
            color: #315f97;
            font-weight: 800;
          }
          .report-title {
            margin: 0;
            font-size: 32px;
            line-height: 1.05;
          }
          .report-subtitle {
            margin: 10px 0 0;
            color: var(--muted);
            font-size: 15px;
          }
          .report-meta {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 12px;
            margin-top: 20px;
          }
          .report-meta__item {
            border: 1px solid var(--line);
            border-radius: 16px;
            padding: 12px 14px;
            background: var(--panel);
          }
          .report-meta__label {
            margin: 0 0 6px;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: var(--muted);
            font-weight: 700;
          }
          .report-meta__value {
            margin: 0;
            font-size: 15px;
            font-weight: 700;
          }
          .report-list {
            display: grid;
            gap: 18px;
          }
          .report-entry {
            border: 1px solid var(--line);
            border-radius: 22px;
            padding: 18px 20px;
            break-inside: avoid;
            page-break-inside: avoid;
          }
          .report-entry__top {
            display: flex;
            justify-content: space-between;
            gap: 16px;
            align-items: flex-start;
          }
          .report-entry__sequence {
            display: inline-flex;
            align-items: center;
            min-height: 30px;
            padding: 0 12px;
            border-radius: 999px;
            background: var(--accent-soft);
            color: #8d560d;
            font-size: 12px;
            font-weight: 800;
            letter-spacing: 0.06em;
            text-transform: uppercase;
          }
          .report-entry__title {
            margin: 10px 0 0;
            font-size: 22px;
            line-height: 1.2;
          }
          .report-entry__date,
          .report-entry__byline {
            margin: 6px 0 0;
            color: var(--muted);
            font-size: 14px;
          }
          .report-entry__badges {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            justify-content: flex-end;
          }
          .report-badge {
            display: inline-flex;
            align-items: center;
            min-height: 28px;
            padding: 0 11px;
            border-radius: 999px;
            background: var(--blue-soft);
            color: #315f97;
            font-size: 12px;
            font-weight: 700;
          }
          .report-tags {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 14px;
          }
          .report-sections {
            display: grid;
            gap: 10px;
            margin-top: 16px;
          }
          .report-section {
            border: 1px solid var(--line);
            border-radius: 16px;
            padding: 12px 14px;
            background: #fbfdff;
          }
          .report-section__label {
            margin: 0 0 6px;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: var(--muted);
            font-weight: 800;
          }
          .report-section__value {
            margin: 0;
            white-space: pre-wrap;
            line-height: 1.5;
            font-size: 14px;
          }
          .report-footer {
            margin-top: 26px;
            padding-top: 14px;
            border-top: 1px solid var(--line);
            color: var(--muted);
            font-size: 12px;
          }
          @media print {
            .sheet { max-width: none; padding: 20px 24px 28px; }
            .report-entry { box-shadow: none; }
          }
        </style>
      </head>
      <body>
        <main class="sheet">
          <header class="report-header">
            <p class="report-kicker">Musicala · Historial pedagogico</p>
            <h1 class="report-title">${escapeHtml(studentName)}</h1>
            <p class="report-subtitle">Documento consolidado de clases, observaciones y avances.</p>
            <section class="report-meta">
              <article class="report-meta__item">
                <p class="report-meta__label">Documento</p>
                <p class="report-meta__value">${escapeHtml(studentDocument)}</p>
              </article>
              <article class="report-meta__item">
                <p class="report-meta__label">Procesos</p>
                <p class="report-meta__value">${escapeHtml(processSummary)}</p>
              </article>
              <article class="report-meta__item">
                <p class="report-meta__label">Total de clases</p>
                <p class="report-meta__value">${escapeHtml(String(items.length))}</p>
              </article>
              <article class="report-meta__item">
                <p class="report-meta__label">Generado</p>
                <p class="report-meta__value">${escapeHtml(printedAt)}</p>
              </article>
            </section>
          </header>

          <section class="report-list">
            ${items.map((item, index) => renderPrintableBitacora(item, index, items.length)).join("")}
          </section>

          <footer class="report-footer">
            Documento preparado desde Bitacoras de Clase para impresion o guardado en PDF.
          </footer>
        </main>
        <script>
          window.addEventListener('load', () => {
            setTimeout(() => {
              window.print();
            }, 180);
          });
        </script>
      </body>
    </html>
  `;
}

function renderPrintableBitacora(item, index = 0, total = 0) {
  const mode = getAllowedMode(item.mode || CONFIG.modes.individual);
  const structuredContent = parseStructuredContent(item.contenido || "");
  const authorName = getBitacoraAuthorName(item, structuredContent);
  const tags = Array.isArray(item.etiquetas) ? item.etiquetas : [];
  const studentsLabel =
    mode === CONFIG.modes.group
      ? `${(item.studentRefs || []).length || (item.studentIds || []).length || 0} estudiantes`
      : "Individual";

  return `
    <article class="report-entry">
      <div class="report-entry__top">
        <div>
          <span class="report-entry__sequence">Clase ${escapeHtml(formatBitacoraSequence(index + 1))}</span>
          <h2 class="report-entry__title">${escapeHtml(item.titulo || "Registro sin titulo")}</h2>
          <p class="report-entry__date">${escapeHtml(formatDisplayDate(item.fechaClase || item.createdAt))}</p>
          ${
            authorName
              ? `<p class="report-entry__byline">Registrada por ${escapeHtml(authorName)}</p>`
              : ""
          }
        </div>
        <div class="report-entry__badges">
          <span class="report-badge">${escapeHtml(mode === CONFIG.modes.group ? "Grupal" : "Individual")}</span>
          <span class="report-badge">${escapeHtml(studentsLabel)}</span>
          ${
            total > 1
              ? `<span class="report-badge">${escapeHtml(`${index + 1} de ${total}`)}</span>`
              : ""
          }
        </div>
      </div>
      ${
        tags.length
          ? `<div class="report-tags">${tags
              .map((tag) => `<span class="report-badge">${escapeHtml(tag)}</span>`)
              .join("")}</div>`
          : ""
      }
      <div class="report-sections">
        ${renderPrintableSection("Docente de la clase", firstNonEmpty(structuredContent.docente, authorName))}
        ${renderPrintableSection("Tareas / observaciones", structuredContent.tareas)}
        ${renderPrintableSection("Componente corporal", joinListValues(structuredContent.componenteCorporal))}
        ${renderPrintableSection("Componente tecnico", joinListValues(structuredContent.componenteTecnico))}
        ${renderPrintableSection("Componente teorico", joinListValues(structuredContent.componenteTeorico))}
        ${renderPrintableSection("Componente de obras", joinListValues(structuredContent.componenteObras))}
        ${renderPrintableStudentsSection(item)}
        ${renderPrintableOverridesSection(item)}
      </div>
    </article>
  `;
}

function renderPrintableSection(label, value) {
  const safeValue = toStringSafe(value);
  if (!safeValue) return "";

  return `
    <section class="report-section">
      <p class="report-section__label">${escapeHtml(label)}</p>
      <p class="report-section__value">${escapeHtml(safeValue)}</p>
    </section>
  `;
}

function renderPrintableStudentsSection(item = {}) {
  if (!Array.isArray(item.studentRefs) || item.studentRefs.length < 2) return "";

  return renderPrintableSection(
    "Estudiantes incluidos",
    item.studentRefs.map((student) => student.name || student.id || "Estudiante").join(" · ")
  );
}

function renderPrintableOverridesSection(item = {}) {
  const overrides = normalizeStudentOverrides(item.studentOverrides, item.studentIds || []);
  const blocks = Object.entries(overrides)
    .map(([studentId, override]) => {
      const studentName =
        item.studentRefs?.find((student) => student.id === studentId)?.name ||
        studentId;
      const lines = [
        override.tareas ? `Observacion: ${override.tareas}` : "",
        joinListValues(override.etiquetas) ? `Categorias: ${joinListValues(override.etiquetas)}` : "",
        joinListValues(override.componenteCorporal)
          ? `Corporal: ${joinListValues(override.componenteCorporal)}`
          : "",
        joinListValues(override.componenteTecnico)
          ? `Tecnico: ${joinListValues(override.componenteTecnico)}`
          : "",
        joinListValues(override.componenteTeorico)
          ? `Teorico: ${joinListValues(override.componenteTeorico)}`
          : "",
        joinListValues(override.componenteObras)
          ? `Obras: ${joinListValues(override.componenteObras)}`
          : "",
      ].filter(Boolean);

      if (!lines.length) return "";
      return `${studentName}: ${lines.join(" | ")}`;
    })
    .filter(Boolean);

  if (!blocks.length) return "";
  return renderPrintableSection("Ajustes individuales", blocks.join("\n"));
}

async function safeLoadBitacoras(studentRef) {
  const response = await getBitacorasByStudent(studentRef);
  const items = normalizeBitacorasResponse(response);
  return sortBitacorasByDate(items);
}

function normalizeBitacorasResponse(response) {
  return normalizeBitacorasResponseShared(response, normalizeBitacora);
}

function normalizeBitacora(item) {
  if (!item || typeof item !== "object") return null;

  const fallbackId =
    item.id ||
    item.bitacoraId ||
    item.ID ||
    item._id ||
    `${item.studentKey || item.studentId || "student"}_${
      item.fechaClase || item.createdAt || Date.now()
    }`;

  return {
    ...item,
    id: String(fallbackId),
    mode: normalizeMode(item.mode || item.modo || CONFIG.modes.individual),
    titulo: item.titulo || item.title || "Bitácora sin título",
    contenido: item.contenido || item.content || "",
    etiquetas: normalizeTags(item.etiquetas || item.tags || []),
    fechaClase: item.fechaClase || item.fecha || item.classDate || "",
    archivos: normalizeFiles(item.archivos || item.attachments || []),
    studentIds: normalizeStudentIds(item.studentIds || [item.studentId]),
    studentRefs: normalizeStudentRefs(item.studentRefs || []),
    studentOverrides: normalizeStudentOverrides(
      item.studentOverrides || item.overrides,
      normalizeStudentIds(item.studentIds || [item.studentId])
    ),
    createdAt: item.createdAt || item.created_at || item.fechaRegistro || "",
    author: item.author || null,
  };
}

function normalizeCreatedBitacora(response, fallbackPayload) {
  const item =
    response?.data ||
    response?.item ||
    response?.bitacora ||
    response ||
    fallbackPayload;

  return normalizeBitacora({
    ...fallbackPayload,
    ...item,
    createdAt:
      item?.createdAt ||
      item?.created_at ||
      fallbackPayload.createdAt ||
      new Date().toISOString(),
  });
}

function buildBitacoraPayload(student, draft) {
  const studentRef = getStudentIdentity(student);
  const allStudents = getAllStudentsFromState(getState());
  const selectedStudents = getSelectedStudentsForDraft(draft, student, allStudents);
  const mode = getAllowedMode(draft.mode);
  const structured = getStructuredDraftFields(draft, student);
  const selectedTeacher =
    toStringSafe(viewRoot?.querySelector("#bitacora-docente")?.value) ||
    structured.docente ||
    firstNonEmpty(student.docente, student.teacher);

  const studentIds =
    mode === CONFIG.modes.group
      ? selectedStudents.map((item) => item.id)
      : [studentRef];

  const studentRefs =
    mode === CONFIG.modes.group
      ? selectedStudents.map((item) => ({
          id: item.id,
          name: item.name,
        }))
      : [
          {
            id: studentRef,
            name: getStudentName(student),
          },
        ];

  return {
    mode,
    studentId: studentRef,
    studentKey: student.studentKey || studentRef,
    studentIds,
    studentRefs,
    primaryStudentId: studentRef,
    title: String(draft.titulo || buildAutoTitle(student, draft.fechaClase)).trim(),
    content: String(draft.contenido || "").trim(),
    tags: normalizeTags(draft.etiquetas),
    fechaClase: draft.fechaClase || getTodayDate(),
    attachments: normalizeFiles(draft.archivos),
    archivos: normalizeFiles(draft.archivos),
    studentOverrides: normalizeStudentOverrides(draft.studentOverrides, studentIds),
    process: {
      area: firstNonEmpty(student.area, student.programa, student.instrumento),
      modalidad: firstNonEmpty(student.modalidad),
      docente: selectedTeacher,
      sede: firstNonEmpty(student.sede),
      programa: firstNonEmpty(student.programa, student.area),
    },
    author: buildAuthorFromState(),
    createdAt: new Date().toISOString(),
  };
}

function validateDraft(draft, student) {
  if (!draft) {
    return { valid: false, message: "No hay información para guardar." };
  }

  if (!String(draft.fechaClase || "").trim()) {
    return { valid: false, message: "La fecha de clase es obligatoria." };
  }

  if (!String(draft.titulo || "").trim()) {
    return { valid: false, message: "El título es obligatorio." };
  }

  if (!String(draft.contenido || "").trim()) {
    return { valid: false, message: "La bitácora no puede quedar vacía." };
  }

  const maxLength = CONFIG?.limits?.maxBitacoraLength || 8000;
  if (String(draft.contenido || "").length > maxLength) {
    return {
      valid: false,
      message: `La bitácora supera el máximo de ${maxLength} caracteres.`,
    };
  }

  const mode = getAllowedMode(draft.mode);
  if (mode === CONFIG.modes.group) {
    const selectedStudents = getSelectedStudentsForDraft(
      draft,
      student,
      getAllStudentsFromState(getState())
    );

    if (selectedStudents.length < 2) {
      return {
        valid: false,
        message:
          CONFIG?.text?.emptyGroup ||
          "La bitácora grupal requiere al menos dos estudiantes.",
      };
    }
  }

  return { valid: true };
}

function collectStudentOverridesFromForm(selectedStudents = []) {
  const next = {};

  selectedStudents.forEach((selectedStudent) => {
    const studentId = toStringSafe(selectedStudent?.id);
    if (!studentId) return;

    const enabled = Boolean(
      viewRoot?.querySelector(`[data-override-enabled="${studentId}"]`)?.checked
    );

    const tareas = toStringSafe(
      viewRoot?.querySelector(`[data-override-textarea="${studentId}"]`)?.value
    );

    const override = {
      enabled,
      tareas,
      etiquetas: getOverrideMultiValueSelection(studentId, "etiquetas"),
      componenteCorporal: getOverrideMultiValueSelection(
        studentId,
        "componenteCorporal"
      ),
      componenteTecnico: getOverrideMultiValueSelection(studentId, "componenteTecnico"),
      componenteTeorico: getOverrideMultiValueSelection(studentId, "componenteTeorico"),
      componenteObras: getOverrideMultiValueSelection(studentId, "componenteObras"),
    };

    const normalized = normalizeStudentOverrides({ [studentId]: override }, [studentId]);
    if (normalized[studentId]) {
      next[studentId] = normalized[studentId];
    }
  });

  return next;
}

function updateDraftFromForm(student) {
  const studentRef = getStudentIdentity(student);
  const existingDraft = getDraftForContext(student);

  const nextMode = getAllowedMode(
    viewRoot?.querySelector('input[name="modoBitacora"]:checked')?.value ||
      existingDraft.mode ||
      CONFIG.modes.individual
  );

  const selectedStudents = getSelectedStudentsForDraft(
    {
      ...existingDraft,
      mode: nextMode,
    },
    student,
    getAllStudentsFromState(getState())
  );

  const structuredFields = {
    docente: viewRoot?.querySelector("#bitacora-docente")?.value || "",
    tareas: viewRoot?.querySelector("#bitacora-tareas")?.value || "",
    componenteCorporal: getMultiValueSelection("componenteCorporal"),
    componenteTecnico: getMultiValueSelection("componenteTecnico"),
    componenteTeorico: getMultiValueSelection("componenteTeorico"),
    componenteObras: getMultiValueSelection("componenteObras"),
  };

  const nextFecha = viewRoot?.querySelector("#bitacora-fecha")?.value || "";
  const nextTitulo = buildAutoTitle(student, nextFecha);
  const nextContenido = buildStructuredContent(structuredFields);

  const nextDraft = {
    ...existingDraft,
    mode: nextMode,
    studentId: studentRef,
    studentKey: student.studentKey || studentRef,
    studentIds:
      nextMode === CONFIG.modes.group
        ? selectedStudents.map((item) => item.id)
        : [studentRef],
    studentRefs:
      nextMode === CONFIG.modes.group
        ? selectedStudents.map((item) => ({
            id: item.id,
            name: item.name,
          }))
        : [
            {
              id: studentRef,
              name: getStudentName(student),
            },
          ],
    fechaClase: nextFecha,
    titulo: nextTitulo,
    etiquetas: getMultiValueSelection("etiquetas"),
    contenido: nextContenido,
    archivos: Array.isArray(existingDraft.archivos)
      ? existingDraft.archivos
      : [],
    studentOverrides:
      nextMode === CONFIG.modes.group
        ? collectStudentOverridesFromForm(selectedStudents)
        : {},
  };

  const titleInput = viewRoot?.querySelector("#bitacora-titulo");
  if (titleInput) {
    titleInput.value = nextTitulo;
  }

  const contentInput = viewRoot?.querySelector("#bitacora-contenido");
  if (contentInput) {
    contentInput.value = nextContenido;
  }

  updateDraft(nextDraft);
  currentEditorMode = nextDraft.mode;
  return nextDraft;
}

function getDraftForContext(student) {
  const draft = getCurrentDraft() || {};
  const studentRef = isPlainObject(student)
    ? getStudentIdentity(student)
    : toStringSafe(student);

  const defaultDraft = createDefaultDraft(studentRef, student);

  if (!studentRef) {
    return defaultDraft;
  }

  if (!draftBelongsToContext(draft, studentRef)) {
    return defaultDraft;
  }

  const normalizedMode = getAllowedMode(draft.mode || CONFIG.modes.individual);
  const baseStudentRefs = getSelectedStudentsForDraft(
    {
      ...draft,
      mode: normalizedMode,
    },
    student,
    getAllStudentsFromState(getState())
  );

  return {
    ...defaultDraft,
    ...draft,
    mode: normalizedMode,
    studentId: draft.studentId || studentRef,
    studentKey:
      draft.studentKey ||
      (isPlainObject(student) ? student.studentKey || studentRef : studentRef),
    studentIds:
      normalizedMode === CONFIG.modes.group
        ? baseStudentRefs.map((item) => item.id)
        : [studentRef],
    studentRefs:
      normalizedMode === CONFIG.modes.group
        ? baseStudentRefs.map((item) => ({
            id: item.id,
            name: item.name,
          }))
        : [
            {
              id: studentRef,
              name: isPlainObject(student) ? getStudentName(student) : studentRef,
            },
          ],
    fechaClase: draft.fechaClase || getTodayDate(),
    titulo: draft.titulo || "",
    etiquetas: Array.isArray(draft.etiquetas) ? draft.etiquetas : [],
    contenido: draft.contenido || "",
    archivos: normalizeFiles(draft.archivos || []),
    studentOverrides: normalizeStudentOverrides(draft.studentOverrides, baseStudentRefs.map((item) => item.id)),
  };
}

function createDefaultDraft(studentRef, student, mode = CONFIG.modes.individual) {
  const normalizedMode = getAllowedMode(mode);
  const baseStudentName = isPlainObject(student) ? getStudentName(student) : "";
  const refs = [
    {
      id: studentRef,
      name: baseStudentName,
    },
  ];

  return {
    mode: normalizedMode,
    studentId: studentRef || "",
    studentKey: isPlainObject(student) ? student.studentKey || studentRef : studentRef,
    studentIds: refs.map((item) => item.id).filter(Boolean),
    studentRefs: refs.filter((item) => item.id),
    fechaClase: getTodayDate(),
    titulo: "",
    etiquetas: [],
    contenido: "",
    archivos: [],
    studentOverrides: {},
  };
}

function draftBelongsToContext(draft, studentOrRef) {
  const studentRef = isPlainObject(studentOrRef)
    ? getStudentIdentity(studentOrRef)
    : toStringSafe(studentOrRef);

  if (!studentRef) return false;
  if (!draft || typeof draft !== "object") return false;

  const draftRefs = [
    draft.studentId,
    draft.studentKey,
    ...(Array.isArray(draft.studentIds) ? draft.studentIds : []),
  ]
    .map((value) => toStringSafe(value))
    .filter(Boolean);

  return draftRefs.includes(studentRef);
}

function resetDraftForContext({ mode = CONFIG.modes.individual, student } = {}) {
  const studentRef = isPlainObject(student) ? getStudentIdentity(student) : "";
  const nextDraft = createDefaultDraft(studentRef, student, mode);

  resetDraft(nextDraft);
  clearUploads();
  currentEditorMode = getAllowedMode(mode);
}

function renderFilesPreviewBlock(student) {
  const container = viewRoot?.querySelector("#bitacora-files-preview");
  if (!container) return;

  const draft = getDraftForContext(student);
  container.innerHTML = renderFilesPreview(draft.archivos || []);
}

function renderFilesPreview(files = []) {
  if (!Array.isArray(files) || !files.length) {
    return `
      <div class="empty-state empty-state--files">
        <p class="empty-state__text">No hay archivos seleccionados.</p>
      </div>
    `;
  }

  return `
    <div class="files-preview__list">
      ${files
        .map(
          (file) => `
            <article class="file-chip">
              <div class="file-chip__body">
                <p class="file-chip__name">
                  ${escapeHtml(file.name || file.nombre || "Archivo")}
                </p>
                <p class="file-chip__meta">
                  ${escapeHtml(
                    [
                      file.kind === "video" ? "Video" : "Archivo",
                      formatFileSize(file.size || 0),
                    ]
                      .filter(Boolean)
                      .join(" • ")
                  )}
                </p>
              </div>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderDraftMetaBlock(student) {
  const container = viewRoot?.querySelector("#editor-form-meta");
  if (!container) return;

  const draft = getDraftForContext(student);
  container.innerHTML = renderDraftMeta(
    draft,
    student,
    getAllStudentsFromState(getState())
  );
}

function renderDraftMeta(draft, student, allStudents = []) {
  const contentLength = String(draft?.contenido || "").length;
  const tagsLength = Array.isArray(draft?.etiquetas) ? draft.etiquetas.length : 0;
  const filesLength = Array.isArray(draft?.archivos) ? draft.archivos.length : 0;
  const studentsLength = getSelectedStudentsForDraft(
    draft,
    student,
    allStudents
  ).length;
  const overridesLength = Object.keys(
    normalizeStudentOverrides(draft?.studentOverrides, draft?.studentIds || [])
  ).length;
  const maxLength = CONFIG?.limits?.maxBitacoraLength || 8000;
  const mode = getAllowedMode(draft?.mode);

  return `
    <div class="draft-meta">
      <span class="draft-meta__item">${contentLength}/${maxLength} caracteres</span>
      <span class="draft-meta__item">${tagsLength} etiqueta${tagsLength === 1 ? "" : "s"}</span>
      <span class="draft-meta__item">${filesLength} archivo${filesLength === 1 ? "" : "s"}</span>
      <span class="draft-meta__item">
        ${mode === CONFIG.modes.group ? `${studentsLength} estudiantes` : "Individual"}
      </span>
      ${
        mode === CONFIG.modes.group
          ? `<span class="draft-meta__item">${overridesLength} ajuste${overridesLength === 1 ? "" : "s"} individual${overridesLength === 1 ? "" : "es"}</span>`
          : ""
      }
    </div>
  `;
}

function renderStudentSummary(student) {
  if (!student) {
    return `
      <div class="empty-state">
        <p class="empty-state__text">No hay estudiante seleccionado.</p>
      </div>
    `;
  }

  return `
    <article class="student-summary">
      <div class="student-summary__identity">
        <p class="student-summary__eyebrow">Estudiante activo</p>
        <h2 class="student-summary__name">${escapeHtml(getStudentName(student))}</h2>
        <p class="student-summary__doc">${escapeHtml(getStudentDocument(student) || "Sin documento")}</p>
      </div>

      <dl class="student-summary__grid">
        ${renderSummaryItem("Estado", getReadableValue(student.estado))}
        ${renderSummaryItem("Procesos", getReadableValue(getStudentProcessesSummary(student), "Sin procesos"))}
        ${renderSummaryItem("Modalidad", getReadableValue(student.modalidad))}
        ${renderSummaryItem("Docente", getReadableValue(student.docente || student.teacher))}
        ${renderSummaryItem("Sede", getReadableValue(student.sede))}
        ${renderSummaryItem("Acudiente", getReadableValue(student.acudiente || student.responsable))}
      </dl>
    </article>
  `;
}

function renderBitacorasHistory(
  items = [],
  isLoading = false,
  config,
  isAuthenticated = true
) {
  if (!isAuthenticated) {
    return `
      <div class="empty-state">
        <p class="empty-state__title">Historial protegido</p>
        <p class="empty-state__text">
          Inicia sesiÃ³n con Google para ver las bitÃ¡coras guardadas de este estudiante.
        </p>
      </div>
    `;
  }

  if (isLoading) {
    return `
      <div class="loading-state">
        <p class="loading-state__text">
          ${escapeHtml(config?.text?.loading || "Cargando...")}
        </p>
      </div>
    `;
  }

  if (!Array.isArray(items) || !items.length) {
    return `
      <div class="empty-state">
        <p class="empty-state__title">Sin historial</p>
        <p class="empty-state__text">
          ${escapeHtml(
            config?.text?.emptyBitacoras ||
              "Este estudiante aún no tiene bitácoras registradas."
          )}
        </p>
      </div>
    `;
  }

  const sortedItems = sortBitacorasByDate(items);

  return `
    <div class="bitacoras-list">
      ${sortedItems
        .map((item, index) => renderBitacoraCard(item, index, sortedItems.length))
        .join("")}
    </div>
  `;
}

function renderBitacoraCard(item, index = 0, total = 0) {
  const mode = getAllowedMode(item.mode || CONFIG.modes.individual);
  const studentsLabel =
    mode === CONFIG.modes.group
      ? `${(item.studentRefs || []).length || (item.studentIds || []).length || 0} estudiantes`
      : "Individual";
  const structuredContent = parseStructuredContent(item.contenido || "");
  const studentOverrides = normalizeStudentOverrides(
    item.studentOverrides,
    item.studentIds || []
  );
  const authorName = getBitacoraAuthorName(item, structuredContent);
  const sequence = formatBitacoraSequence(index + 1);

  return `
    <article class="bitacora-card">
      <header class="bitacora-card__header">
        <div>
          <h3 class="bitacora-card__title">
            ${escapeHtml(item.titulo || "Sin título")}
          </h3>
            <p class="bitacora-card__date">
              ${escapeHtml(formatDisplayDate(item.fechaClase || item.createdAt))}
            </p>
            ${
              authorName
                ? `<p class="bitacora-card__byline">Registrada por <strong>${escapeHtml(authorName)}</strong></p>`
                : ""
            }
          </div>

        <div class="bitacora-card__meta">
          <span class="badge">${escapeHtml(mode === CONFIG.modes.group ? "Grupal" : "Individual")}</span>
          <span class="badge">${escapeHtml(studentsLabel)}</span>
          ${
            total > 1
              ? `<span class="badge badge--soft">${escapeHtml(`${index + 1} de ${total}`)}</span>`
              : ""
          }
        </div>
      </header>

      ${
        Array.isArray(item.etiquetas) && item.etiquetas.length
          ? `
            <div class="bitacora-card__tags">
              ${item.etiquetas
                .map((tag) => `<span class="badge">${escapeHtml(tag)}</span>`)
                .join("")}
            </div>
          `
          : ""
      }

      <div class="bitacora-card__content">
        ${renderBitacoraStructuredSections(structuredContent)}
      </div>

      ${
        Object.keys(studentOverrides).length
          ? `
            <div class="bitacora-card__overrides">
              <p class="bitacora-card__files-title">Ajustes individuales</p>
              <div class="bitacora-card__override-list">
                ${renderBitacoraOverrideCards(item, studentOverrides)}
              </div>
            </div>
          `
          : ""
      }

      ${
        Array.isArray(item.studentRefs) && item.studentRefs.length > 1
          ? `
            <div class="bitacora-card__group">
              <p class="bitacora-card__files-title">Estudiantes incluidos</p>
              <div class="bitacora-card__tags">
                ${item.studentRefs
                  .map(
                    (student) => `
                      <span class="badge badge--soft">
                        ${escapeHtml(student.name || student.id || "Estudiante")}
                      </span>
                    `
                  )
                  .join("")}
              </div>
            </div>
          `
          : ""
      }

      ${
        Array.isArray(item.archivos) && item.archivos.length
          ? `
            <div class="bitacora-card__files">
              <p class="bitacora-card__files-title">Archivos adjuntos</p>
              <ul class="bitacora-card__files-list">
                ${item.archivos
                  .map(
                    (file) => `
                      <li>${escapeHtml(
                        file.name || file.nombre || "Archivo adjunto"
                      )}</li>
                    `
                  )
                  .join("")}
              </ul>
            </div>
          `
          : ""
      }
    </article>
  `;
}

function renderGroupSelectionBlocks(student) {
  const draft = getDraftForContext(student);
  const allStudents = getAllStudentsFromState(getState());
  const selected = getSelectedStudentsForDraft(draft, student, allStudents);
  const searchValue =
    viewRoot?.querySelector("#group-students-search")?.value || "";

  const selectedContainer = viewRoot?.querySelector("#group-selected-students");
  const resultsContainer = viewRoot?.querySelector("#group-students-results");

  if (selectedContainer) {
    selectedContainer.innerHTML = renderSelectedStudentsChips(selected);
  }

  if (resultsContainer) {
    resultsContainer.innerHTML = renderGroupStudentsResults(
      allStudents,
      selected,
      searchValue
    );
  }

  renderStudentOverridesBlock(student);
  toggleGroupModeBlock(draft.mode === CONFIG.modes.group);
}

function renderStudentOverridesBlock(student) {
  const container = viewRoot?.querySelector("#student-overrides-block");
  if (!container) return;

  const draft = getDraftForContext(student);
  const selectedStudents = getSelectedStudentsForDraft(
    draft,
    student,
    getAllStudentsFromState(getState())
  );

  container.innerHTML = renderStudentOverridesEditor(
    draft,
    selectedStudents,
    getStudentOverrideCatalogOptions()
  );
  container.classList.toggle("is-hidden", draft.mode !== CONFIG.modes.group);
}

function toggleStudentOverride(primaryStudent, studentId, enabled) {
  const safeStudentId = toStringSafe(studentId);
  if (!safeStudentId) return;

  const currentDraft = getDraftForContext(primaryStudent);
  const nextOverrides = {
    ...normalizeStudentOverrides(currentDraft.studentOverrides, currentDraft.studentIds),
  };

  if (enabled) {
    nextOverrides[safeStudentId] = {
      ...buildEmptyStudentOverride(),
      ...(nextOverrides[safeStudentId] || {}),
      enabled: true,
    };
  } else {
    delete nextOverrides[safeStudentId];
  }

  updateDraft({
    ...currentDraft,
    studentOverrides: nextOverrides,
  });

  renderStudentOverridesBlock(primaryStudent);
  renderDraftMetaBlock(primaryStudent);
}

function addStudentOverrideValue(descriptor, rawValue, student) {
  const [studentId = "", key = ""] = String(descriptor || "").split(":");
  if (!studentId || !key) return;

  const input = viewRoot?.querySelector(
    `[data-override-input="${studentId}:${key}"]`
  );
  const valuesToAdd = normalizeListValues(rawValue);
  if (!valuesToAdd.length) return;

  const currentDraft = getDraftForContext(student);
  const currentOverride = getStudentOverrideForDraft(currentDraft, studentId);
  const nextOverride = {
    ...currentOverride,
    enabled: true,
    [key]: normalizeListValues([...(currentOverride[key] || []), ...valuesToAdd]),
  };

  updateDraft({
    ...currentDraft,
    studentOverrides: {
      ...normalizeStudentOverrides(currentDraft.studentOverrides, currentDraft.studentIds),
      [studentId]: nextOverride,
    },
  });

  if (input) input.value = "";
  renderStudentOverridesBlock(student);
  renderDraftMetaBlock(student);
}

function removeStudentOverrideValue(descriptor, student) {
  const studentId = toStringSafe(descriptor?.studentId);
  const key = toStringSafe(descriptor?.key);
  const rawValue = toStringSafe(descriptor?.value);
  if (!studentId || !key || !rawValue) return;

  const currentDraft = getDraftForContext(student);
  const currentOverride = getStudentOverrideForDraft(currentDraft, studentId);
  const nextOverride = {
    ...currentOverride,
    [key]: normalizeListValues(currentOverride[key]).filter((value) => value !== rawValue),
  };

  const nextOverrides = {
    ...normalizeStudentOverrides(currentDraft.studentOverrides, currentDraft.studentIds),
  };

  nextOverrides[studentId] = nextOverride;

  updateDraft({
    ...currentDraft,
    studentOverrides: nextOverrides,
  });

  renderStudentOverridesBlock(student);
  renderDraftMetaBlock(student);
}

function renderSelectedStudentsChips(selectedStudents = []) {
  if (!selectedStudents.length) {
    return `
      <div class="empty-state empty-state--files">
        <p class="empty-state__text">No hay estudiantes seleccionados.</p>
      </div>
    `;
  }

  return `
    <div class="selected-students-chips">
      ${selectedStudents
        .map(
          (student, index) => `
            <article class="selected-student-chip">
              <div class="selected-student-chip__body">
                <p class="selected-student-chip__name">${escapeHtml(student.name || "Estudiante")}</p>
                <p class="selected-student-chip__meta">${escapeHtml(student.document || student.id || "")}</p>
              </div>
              ${
                index === 0
                  ? `<span class="badge badge--soft">Principal</span>`
                  : `
                    <button
                      type="button"
                      class="btn btn--ghost btn--xs"
                      data-group-remove-student="${escapeHtml(student.id)}"
                    >
                      Quitar
                    </button>
                  `
              }
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderGroupStudentsResults(
  allStudents = [],
  selectedStudents = [],
  searchTerm = ""
) {
  const selectedIds = new Set(selectedStudents.map((item) => item.id));
  const queryText = toStringSafe(searchTerm).toLowerCase();

  if (!queryText.trim()) {
    return `
      <div class="group-search-empty">
        <p class="group-search-empty__title">Busca para agregar</p>
        <p class="group-search-empty__text">Escribe al menos 2 letras y te mostramos coincidencias.</p>
      </div>
    `;
  }

  if (queryText.trim().length < 2) {
    return `
      <div class="group-search-empty">
        <p class="group-search-empty__text">Escribe al menos 2 letras para empezar a buscar.</p>
      </div>
    `;
  }

  const results = allStudents
    .filter(Boolean)
    .filter((student) => {
      const id = getStudentIdentity(student);
      if (!id || selectedIds.has(id)) return false;

      const haystack = [
        getStudentName(student),
        getStudentDocument(student),
        student.programa,
        student.instrumento,
        student.area,
        student.docente,
        student.teacher,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(queryText);
    })
    .slice(0, 8);

  if (!results.length) {
    return `
      <div class="empty-state empty-state--files">
        <p class="empty-state__text">No hay más estudiantes para agregar.</p>
      </div>
    `;
  }

  return `
    <div class="group-students-results__list">
      ${results
        .map(
          (student) => `
            <article class="group-student-row">
              <div class="group-student-row__body">
                <p class="group-student-row__name">${escapeHtml(getStudentName(student))}</p>
                <p class="group-student-row__meta">
                  ${escapeHtml(
                    [
                      getStudentDocument(student),
                      firstNonEmpty(student.programa, student.instrumento, student.area),
                    ]
                      .filter(Boolean)
                      .join(" • ")
                  )}
                </p>
              </div>

              <button
                type="button"
                class="btn btn--ghost btn--sm"
                data-group-add-student="${escapeHtml(getStudentIdentity(student))}"
              >
                Agregar
              </button>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function addStudentToGroupDraft(primaryStudent, studentId) {
  const safeStudentId = toStringSafe(studentId);
  if (!safeStudentId) return;

  const allStudents = getAllStudentsFromState(getState());
  const currentDraft = getDraftForContext(primaryStudent);
  const selected = getSelectedStudentsForDraft(currentDraft, primaryStudent, allStudents);
  const exists = selected.some((item) => item.id === safeStudentId);

  if (exists) return;

  const found = allStudents.find(
    (student) => getStudentIdentity(student) === safeStudentId
  );

  if (!found) return;

  const nextSelected = [...selected, mapStudentForSelection(found)];

  updateDraft({
    ...currentDraft,
    mode: CONFIG.modes.group,
    studentIds: nextSelected.map((item) => item.id),
    studentRefs: nextSelected.map((item) => ({
      id: item.id,
      name: item.name,
    })),
    studentOverrides: normalizeStudentOverrides(
      currentDraft.studentOverrides,
      nextSelected.map((item) => item.id)
    ),
  });

  currentEditorMode = CONFIG.modes.group;
}

function removeStudentFromGroupDraft(primaryStudent, studentId) {
  const safeStudentId = toStringSafe(studentId);
  if (!safeStudentId) return;

  const primaryId = getStudentIdentity(primaryStudent);
  if (safeStudentId === primaryId) return;

  const allStudents = getAllStudentsFromState(getState());
  const currentDraft = getDraftForContext(primaryStudent);
  const selected = getSelectedStudentsForDraft(currentDraft, primaryStudent, allStudents);

  const nextSelected = selected.filter((item) => item.id !== safeStudentId);

  updateDraft({
    ...currentDraft,
    mode: CONFIG.modes.group,
    studentIds: nextSelected.map((item) => item.id),
    studentRefs: nextSelected.map((item) => ({
      id: item.id,
      name: item.name,
    })),
    studentOverrides: normalizeStudentOverrides(
      currentDraft.studentOverrides,
      nextSelected.map((item) => item.id)
    ),
  });

  currentEditorMode = CONFIG.modes.group;
}

function toggleGroupModeBlock(show) {
  const block = viewRoot?.querySelector("#group-editor-block");
  const results = viewRoot?.querySelector("#group-students-results");
  const overrides = viewRoot?.querySelector("#student-overrides-block");
  if (block) {
    block.classList.toggle("is-hidden", !show);
  }
  if (results) {
    results.classList.toggle("is-hidden", !show);
  }
  if (overrides) {
    overrides.classList.toggle("is-hidden", !show);
  }
}

async function ensureCatalogsLoaded() {
  catalogsLoadAttempted = true;

  try {
    cachedCatalogs = await getCatalogs();
  } catch (error) {
    console.warn("No se pudieron cargar los catálogos desde Firestore:", error);
    cachedCatalogs =
      cachedCatalogs && Object.keys(cachedCatalogs).length
        ? cachedCatalogs
        : getEmptyCatalogs();
  }

  return cachedCatalogs;
}

function syncModeInputs() {
  const draftMode = getCurrentDraft()?.mode || currentEditorMode || CONFIG.modes.individual;
  const inputs = viewRoot?.querySelectorAll('input[name="modoBitacora"]') || [];

  inputs.forEach((input) => {
    input.checked = input.value === draftMode;
  });

  toggleGroupModeBlock(draftMode === CONFIG.modes.group);
}

function getSelectedStudentsForDraft(draft, primaryStudent, allStudents = []) {
  const primary = mapStudentForSelection(primaryStudent);
  const mode = getAllowedMode(draft?.mode);
  const selectedIds = normalizeStudentIds(draft?.studentIds || []);
  const refsFromDraft = normalizeStudentRefs(draft?.studentRefs || []);
  const resultMap = new Map();

  if (primary?.id) {
    resultMap.set(primary.id, primary);
  }

  refsFromDraft.forEach((item) => {
    if (!item.id) return;

    const matched = allStudents.find(
      (student) => getStudentIdentity(student) === item.id
    );

    resultMap.set(
      item.id,
      matched ? mapStudentForSelection(matched) : mapSelectionFromRef(item)
    );
  });

  selectedIds.forEach((id) => {
    if (resultMap.has(id)) return;

    const matched = allStudents.find(
      (student) => getStudentIdentity(student) === id
    );

    if (matched) {
      resultMap.set(id, mapStudentForSelection(matched));
    } else {
      resultMap.set(id, {
        id,
        name: id,
        document: "",
      });
    }
  });

  const items = [...resultMap.values()].filter((item) => item?.id);

  if (mode === CONFIG.modes.individual) {
    return items.slice(0, 1);
  }

  return items.slice(0, CONFIG?.limits?.maxStudentsPerGroup || 40);
}

function mapStudentForSelection(student) {
  if (!student) return null;

  return {
    id: getStudentIdentity(student),
    name: getStudentName(student),
    document: getStudentDocument(student),
  };
}

function mapSelectionFromRef(ref) {
  return {
    id: toStringSafe(ref.id),
    name: toStringSafe(ref.name) || toStringSafe(ref.id),
    document: "",
  };
}

function getBitacorasFromState(studentOrRef) {
  const studentRef = isPlainObject(studentOrRef)
    ? getStudentIdentity(studentOrRef)
    : toStringSafe(studentOrRef);

  const fallbackId = isPlainObject(studentOrRef)
    ? getStudentFallbackId(studentOrRef)
    : "";

  const selectedItems = getSelectedStudentBitacoras();
  if (Array.isArray(selectedItems) && selectedItems.length) {
    return sortBitacorasByDate(
      selectedItems.map(normalizeBitacora).filter(Boolean)
    );
  }

  const state = getState();
  const candidates = [
    state?.bitacoras?.byStudentId?.[studentRef],
    state?.bitacoras?.itemsByStudentId?.[studentRef],
    state?.bitacoras?.byStudent?.[studentRef],
    fallbackId ? state?.bitacoras?.byStudentId?.[fallbackId] : null,
    fallbackId ? state?.bitacoras?.itemsByStudentId?.[fallbackId] : null,
    fallbackId ? state?.bitacoras?.byStudent?.[fallbackId] : null,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return sortBitacorasByDate(
        candidate.map(normalizeBitacora).filter(Boolean)
      );
    }
  }

  return [];
}

function getStudentFromState(state, preferredStudentRef = null) {
  const selectedRef =
    preferredStudentRef ||
    state?.students?.selected?.studentKey ||
    state?.students?.selected?.id ||
    state?.search?.selectedStudentId ||
    getSelectedStudentId() ||
    null;

  if (!selectedRef) {
    return state?.students?.selected || null;
  }

  return (
    findStudentInCollections(state, selectedRef) ||
    state?.students?.selected ||
    null
  );
}

function getAllStudentsFromState(state) {
  const items = [];
  const seen = new Set();

  const pushStudent = (student) => {
    if (!student || typeof student !== "object") return;
    const id = getStudentIdentity(student);
    if (!id || seen.has(id)) return;
    seen.add(id);
    items.push(student);
  };

  if (state?.students?.selected) {
    pushStudent(state.students.selected);
  }

  if (Array.isArray(state?.search?.results)) {
    state.search.results.forEach(pushStudent);
  }

  if (Array.isArray(state?.search?.filteredResults)) {
    state.search.filteredResults.forEach(pushStudent);
  }

  if (isPlainObject(state?.students?.byId)) {
    Object.values(state.students.byId).forEach(pushStudent);
  }

  return items;
}

function buildAuthorFromState() {
  const state = getState();

  const candidates = [
    state?.session?.user,
    state?.auth?.user,
    state?.user,
  ].filter(Boolean);

  for (const user of candidates) {
    const uid = toStringSafe(user.uid);
    if (!uid) continue;

    return {
      uid,
      name: toStringSafe(user.name || user.displayName),
      email: toStringSafe(user.email),
      photoURL: toStringSafe(user.photoURL),
    };
  }

  return {
    uid: "",
    name: "",
    email: "",
    photoURL: "",
  };
}

function renderSummaryItem(label, value) {
  return `
    <div class="student-summary__item">
      <dt class="student-summary__label">${escapeHtml(label)}</dt>
      <dd class="student-summary__value">${escapeHtml(String(value ?? ""))}</dd>
    </div>
  `;
}

function renderMissingStudent() {
  return `
    <section class="view-shell view-shell--editor-missing">
      <div class="card empty-state-card">
        <p class="view-eyebrow">Editor</p>
        <h1 class="view-title">No hay estudiante seleccionado</h1>
        <p class="view-description">
          Primero seleccionen un estudiante desde búsqueda. El sistema no puede
          adivinar a quién le están escribiendo la bitácora, por más ganas que tenga.
        </p>
        <div class="empty-state-card__actions">
          <button
            type="button"
            class="btn btn--primary"
            id="editor-missing-back-btn"
          >
            Ir a búsqueda
          </button>
        </div>
      </div>
    </section>
  `;
}

function parseTagsFromInput(value) {
  return String(value || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/**
 * Se deja local a propósito:
 * la rama string usa parse simple y no conviene cambiar esa microconducta
 * en esta pasada de refactor.
 */
function normalizeTags(tags) {
  if (Array.isArray(tags)) {
    return [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))];
  }

  if (typeof tags === "string") {
    return parseTagsFromInput(tags);
  }

  return [];
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) return [];

  return files
    .filter(Boolean)
    .map((file) => ({
      name: file.name || file.nombre || "Archivo",
      type: file.type || "",
      size: Number(file.size || 0),
      lastModified: file.lastModified || null,
      url: file.url || "",
      path: file.path || "",
    }));
}

function formatTagsForInput(tags) {
  return normalizeTags(tags).join(", ");
}

function mapFileToDraftItem(file, kind = "support") {
  return {
    name: file.name,
    type: file.type,
    size: file.size,
    lastModified: file.lastModified,
    kind,
  };
}

/**
 * Se deja local para mantener el criterio exacto del historial actual:
 * fechaClase o createdAt, sin meter otros fallbacks.
 */
function sortBitacorasByDate(items = []) {
  return [...items].sort((a, b) => {
    const dateA = getTimestamp(a.fechaClase || a.createdAt);
    const dateB = getTimestamp(b.fechaClase || b.createdAt);
    return dateB - dateA;
  });
}

function formatFileSize(bytes) {
  const size = Number(bytes || 0);

  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function goToSearch() {
  if (typeof currentNavigateTo !== "function") return;
  currentNavigateTo(CONFIG.routes.search);
}

function goToProfile(student) {
  if (typeof currentNavigateTo !== "function" || !student) return;

  currentNavigateTo(CONFIG.routes.profile, {
    id: student.id,
    studentId: student.id,
    studentKey: student.studentKey || student.id,
  });
}

function syncInputValue(selector, value) {
  const input = viewRoot?.querySelector(selector);
  if (!input) return;
  if (document.activeElement === input) return;
  if (input.value !== value) input.value = value;
}

function syncTextareaValue(selector, value) {
  const textarea = viewRoot?.querySelector(selector);
  if (!textarea) return;
  if (document.activeElement === textarea) return;
  if (textarea.value !== value) textarea.value = value;
}

function getAllowedMode(mode) {
  const normalized = normalizeMode(mode);
  if (normalized === CONFIG.modes.group && !canUseGroupBitacoras()) {
    return CONFIG.modes.individual;
  }
  return normalized;
}

function getRequestedModeFromPayload(payload) {
  const rawMode = toStringSafe(payload?.mode);
  if (!rawMode) return "";
  return getAllowedMode(rawMode);
}

function buildDraftWithMode({
  draft,
  student,
  mode,
  allStudents = [],
}) {
  const safeMode = getAllowedMode(mode);
  const primaryId = getStudentIdentity(student);
  const primaryName = getStudentName(student);

  if (safeMode === CONFIG.modes.group) {
    const selectedStudents = getSelectedStudentsForDraft(
      {
        ...draft,
        mode: safeMode,
      },
      student,
      allStudents
    );

    return {
      ...draft,
      mode: safeMode,
      studentId: primaryId,
      studentKey: student?.studentKey || primaryId,
      studentIds: selectedStudents.map((item) => item.id),
      studentRefs: selectedStudents.map((item) => ({
        id: item.id,
        name: item.name,
      })),
      studentOverrides: normalizeStudentOverrides(
        draft.studentOverrides,
        selectedStudents.map((item) => item.id)
      ),
    };
  }

  return {
    ...draft,
    mode: CONFIG.modes.individual,
    studentId: primaryId,
    studentKey: student?.studentKey || primaryId,
    studentIds: primaryId ? [primaryId] : [],
    studentRefs: primaryId
      ? [
          {
            id: primaryId,
            name: primaryName,
          },
        ]
      : [],
    studentOverrides: {},
  };
}

function buildMusicalaEditorMarkup({
  student,
  draft,
  bitacoras,
  isLoading,
  isAuthenticated = false,
  config,
  allStudents = [],
}) {
  const title =
    config?.app?.name ||
    config?.appName ||
    config?.title ||
    "Bitacoras de Clase";
  const isGroup = draft.mode === CONFIG.modes.group;
  const draftFields = getStructuredDraftFields(draft, student);
  const catalogs = cachedCatalogs || getEmptyCatalogs();
  const teacherOptions = getTeacherOptions(
    catalogs.docentes,
    allStudents,
    student,
    draftFields.docente
  );
  const categoriasOptions = getCatalogOptions(catalogs.categorias);
  const corporalOptions = getCatalogOptions(catalogs.componenteCorporal);
  const tecnicoOptions = getCatalogOptions(catalogs.componenteTecnico);
  const teoricoOptions = getCatalogOptions(catalogs.componenteTeorico);
  const obrasOptions = getCatalogOptions(catalogs.componenteObras);
  const selectedStudents = getSelectedStudentsForDraft(draft, student, allStudents);

  return `
    <section class="view-shell view-shell--editor">
      <header class="view-header">
        <div class="view-header__content">
          <p class="view-eyebrow">${escapeHtml(title)}</p>
          <h1 class="view-title">Registro de Clase - Musicala</h1>
          <p class="view-description">
            Usa el mismo formato del registro docente para dejar observaciones,
            componentes y archivos en una sola vista.
          </p>
        </div>
        <div class="view-header__actions">
          <button type="button" class="btn btn--ghost" id="editor-back-search-btn">
            Volver a busqueda
          </button>
          <button type="button" class="btn btn--secondary" id="editor-open-profile-btn">
            Ver perfil
          </button>
        </div>
      </header>

      <section class="editor-layout editor-layout--stack">
        <main class="editor-main editor-main--full">
          <section class="card editor-form editor-form--musicala">
            <header class="editor-form__header">
              <div id="editor-student-summary" class="editor-form__student-strip">
                ${renderStudentSummaryCompact(student)}
              </div>
              ${
                !isAuthenticated
                  ? `
                    <div class="message-box message-box--warning">
                      Inicia sesion con Google para consultar el historial y guardar bitacoras en Firebase.
                    </div>
                  `
                  : ""
              }
            </header>

            <form id="bitacora-form" class="bitacora-form" novalidate>
              <fieldset class="field field--radio-group editor-mode-strip">
                <legend class="field__label">Tipo de registro</legend>
                <label class="choice-pill">
                  <input
                    type="radio"
                    name="modoBitacora"
                    value="${escapeHtml(CONFIG.modes.individual)}"
                    ${!isGroup ? "checked" : ""}
                  />
                  <span>Individual</span>
                </label>
                ${
                  canUseGroupBitacoras()
                    ? `
                      <label class="choice-pill">
                        <input
                          type="radio"
                          name="modoBitacora"
                          value="${escapeHtml(CONFIG.modes.group)}"
                          ${isGroup ? "checked" : ""}
                        />
                        <span>Grupal</span>
                      </label>
                    `
                    : ""
                }
              </fieldset>

              <div class="editor-form-grid editor-form-grid--2">
                <label class="field">
                  <span class="field__label">Fecha</span>
                  <input
                    id="bitacora-fecha"
                    name="fechaClase"
                    type="date"
                    class="field__input"
                    value="${escapeHtml(draft.fechaClase || getTodayDate())}"
                  />
                </label>

                  <label class="field">
                    <span class="field__label">Docente</span>
                    <select id="bitacora-docente" name="docente" class="field__input">
                      <option value="" ${draftFields.docente ? "" : "selected"}>
                        Selecciona un docente...
                      </option>
                      ${teacherOptions
                        .map(
                          (option) => `
                          <option value="${escapeHtml(option)}" ${
                            option === draftFields.docente ? "selected" : ""
                          }>
                            ${escapeHtml(option)}
                          </option>
                        `
                      )
                      .join("")}
                  </select>
                </label>
              </div>

                <section class="field field--selection ${isGroup ? "" : "is-hidden"}" id="group-editor-block">
                  <div class="field__label-row">
                    <span class="field__label">Grupo de estudiantes</span>
                    <span class="field__hint">
                      Busca por nombre y agrega solo los necesarios.
                    </span>
                  </div>
                  <div class="editor-picker">
                    <input
                      id="group-students-search"
                      type="text"
                      class="field__input"
                      placeholder="Busca por nombre, documento, programa o docente..."
                      autocomplete="off"
                    />
                  </div>
                  <div id="group-selected-students" class="group-selected-students">
                    ${renderSelectedStudentsChips(
                      getSelectedStudentsForDraft(draft, student, allStudents)
                    )}
                  </div>
                  <div id="group-students-results" class="group-students-results ${isGroup ? "" : "is-hidden"}">
                    ${renderGroupStudentsResults(
                      allStudents,
                      getSelectedStudentsForDraft(draft, student, allStudents),
                      ""
                    )}
                  </div>
                </section>

              <section
                id="student-overrides-block"
                class="student-overrides ${isGroup ? "" : "is-hidden"}"
              >
                ${renderStudentOverridesEditor(
                  draft,
                  selectedStudents,
                  getStudentOverrideCatalogOptions()
                )}
              </section>

              <div class="editor-form-grid editor-form-grid--2">
                ${renderMultiValueField({
                  key: "etiquetas",
                  label: "Categorias",
                  inputId: "bitacora-etiquetas-input",
                  listId: "bitacora-categorias-list",
                  placeholder: "Escribe o elige una categoria y agrégala...",
                  hint: "Puedes seleccionar varias categorias para la misma clase.",
                  options: categoriasOptions,
                  selectedValues: draft.etiquetas || [],
                })}
              </div>

              <label class="field">
                <span class="field__label">Tareas / Observaciones</span>
                <textarea
                  id="bitacora-tareas"
                  name="tareas"
                  class="field__textarea field__textarea--registro"
                  rows="8"
                  maxlength="${CONFIG?.limits?.maxBitacoraLength || 8000}"
                  placeholder="Logros, dificultades, acuerdos, tareas..."
                >${escapeHtml(draftFields.tareas)}</textarea>
              </label>

              <div class="editor-form-grid editor-form-grid--2">
                ${renderMultiValueField({
                  key: "componenteCorporal",
                  label: "Componente corporal",
                  inputId: "bitacora-componente-corporal-input",
                  listId: "bitacora-componente-corporal-list",
                  placeholder: "Agrega uno o varios ejercicios...",
                  options: corporalOptions,
                  selectedValues: draftFields.componenteCorporal || [],
                })}
                ${renderMultiValueField({
                  key: "componenteTecnico",
                  label: "Componente tecnico",
                  inputId: "bitacora-componente-tecnico-input",
                  listId: "bitacora-componente-tecnico-list",
                  placeholder: "Agrega uno o varios ejercicios...",
                  options: tecnicoOptions,
                  selectedValues: draftFields.componenteTecnico || [],
                })}
              </div>

              <div class="editor-form-grid editor-form-grid--2">
                ${renderMultiValueField({
                  key: "componenteTeorico",
                  label: "Componente teorico",
                  inputId: "bitacora-componente-teorico-input",
                  listId: "bitacora-componente-teorico-list",
                  placeholder: "Agrega uno o varios temas...",
                  options: teoricoOptions,
                  selectedValues: draftFields.componenteTeorico || [],
                })}
                ${renderMultiValueField({
                  key: "componenteObras",
                  label: "Componente de obras",
                  inputId: "bitacora-componente-obras-input",
                  listId: "bitacora-componente-obras-list",
                  placeholder: "Agrega una o varias obras...",
                  options: obrasOptions,
                  selectedValues: draftFields.componenteObras || [],
                })}
              </div>

              <div class="editor-form-grid editor-form-grid--2">
                <label class="field">
                  <span class="field__label">Archivos / Imagenes (opcional)</span>
                  <input
                    id="bitacora-archivos"
                    name="archivos"
                    type="file"
                    class="field__input"
                    multiple
                    accept="image/*,application/pdf,audio/*"
                  />
                </label>
                <label class="field">
                  <span class="field__label">Videos (opcional)</span>
                  <input
                    id="bitacora-videos"
                    name="videos"
                    type="file"
                    class="field__input"
                    multiple
                    accept="video/*"
                  />
                </label>
              </div>

              <div id="bitacora-files-preview" class="files-preview">
                ${renderFilesPreview(draft.archivos || [])}
              </div>

              <input id="bitacora-titulo" name="titulo" type="hidden" value="${escapeHtml(
                draft.titulo || ""
              )}" />
              <textarea
                id="bitacora-contenido"
                name="contenido"
                class="sr-only"
                aria-hidden="true"
                tabindex="-1"
              >${escapeHtml(draft.contenido || "")}</textarea>

              <div class="editor-form__footer">
                <div class="editor-form__meta" id="editor-form-meta">
                  ${renderDraftMeta(draft, student, allStudents)}
                </div>
                <div class="editor-form__actions">
                  <button type="button" class="btn btn--ghost" id="bitacora-reset-btn">
                    Limpiar
                  </button>
                  <button
                    type="submit"
                    class="btn btn--primary"
                    id="bitacora-save-btn"
                    ${!isAuthenticated ? "disabled" : ""}
                  >
                    Guardar bitacora
                  </button>
                </div>
              </div>
            </form>
          </section>

          <section class="card editor-history editor-history--full">
            <header class="editor-history__header">
              <div>
                <p class="panel-header__eyebrow">Historial</p>
                <h2 class="panel-header__title">Bitacoras registradas</h2>
              </div>
              <div class="editor-history__actions">
                <button type="button" class="btn btn--ghost btn--sm" id="bitacora-print-btn">
                  Imprimir historial
                </button>
                <button type="button" class="btn btn--ghost btn--sm" id="bitacora-refresh-btn">
                  Recargar
                </button>
              </div>
            </header>
            <div id="bitacoras-history">
              ${renderBitacorasHistory(bitacoras, isLoading, config, isAuthenticated)}
            </div>
          </section>
        </main>
      </section>
    </section>
  `;
}

function renderBitacoraOverrideCards(item, overrides = {}) {
  return Object.entries(overrides)
    .map(([studentId, override]) => {
      const studentName =
        item.studentRefs?.find((student) => student.id === studentId)?.name ||
        studentId;
      const sections = [
        override.tareas
          ? `<p class="bitacora-card__override-text">${escapeHtml(override.tareas)}</p>`
          : "",
        renderOverrideSummaryLine("Categorias", override.etiquetas),
        renderOverrideSummaryLine("Corporal", override.componenteCorporal),
        renderOverrideSummaryLine("Tecnico", override.componenteTecnico),
        renderOverrideSummaryLine("Teorico", override.componenteTeorico),
        renderOverrideSummaryLine("Obras", override.componenteObras),
      ]
        .filter(Boolean)
        .join("");

      return `
        <article class="bitacora-card__override-card">
          <p class="bitacora-card__override-name">${escapeHtml(studentName)}</p>
          ${sections || `<p class="bitacora-card__override-text">Tiene personalizacion activa.</p>`}
        </article>
      `;
    })
    .join("");
}

function renderOverrideSummaryLine(label, values = []) {
  const text = joinListValues(values);
  if (!text) return "";

  return `
    <p class="bitacora-card__override-line">
      <strong>${escapeHtml(label)}:</strong> ${escapeHtml(text)}
    </p>
  `;
}

function renderBitacoraStructuredSections(content = {}) {
  const tasks = toStringSafe(content.tareas);
  const docente = toStringSafe(content.docente);
  const summaryLines = [
    docente
      ? `<p class="bitacora-card__summary-line"><strong>Docente:</strong> ${escapeHtml(docente)}</p>`
      : "",
    joinListValues(content.componenteCorporal)
      ? `<p class="bitacora-card__summary-line"><strong>Corporal:</strong> ${escapeHtml(
          joinListValues(content.componenteCorporal)
        )}</p>`
      : "",
    joinListValues(content.componenteTecnico)
      ? `<p class="bitacora-card__summary-line"><strong>Tecnico:</strong> ${escapeHtml(
          joinListValues(content.componenteTecnico)
        )}</p>`
      : "",
    joinListValues(content.componenteTeorico)
      ? `<p class="bitacora-card__summary-line"><strong>Teorico:</strong> ${escapeHtml(
          joinListValues(content.componenteTeorico)
        )}</p>`
      : "",
    joinListValues(content.componenteObras)
      ? `<p class="bitacora-card__summary-line"><strong>Obras:</strong> ${escapeHtml(
          joinListValues(content.componenteObras)
        )}</p>`
      : "",
  ].filter(Boolean);

  if (!tasks && !summaryLines.length) {
    return `<p class="bitacora-card__summary-line">Sin contenido registrado.</p>`;
  }

  return `
    <div class="bitacora-card__compact">
      ${
        tasks
          ? `
            <section class="bitacora-card__lead">
              <p class="bitacora-card__section-label">Tareas / observaciones</p>
              <p class="bitacora-card__lead-text">${escapeHtml(tasks)}</p>
            </section>
          `
          : ""
      }
      ${
        summaryLines.length
          ? `
            <section class="bitacora-card__summary">
              ${summaryLines.join("")}
            </section>
          `
          : ""
      }
    </div>
  `;
}

function getBitacoraAuthorName(item = {}, structuredContent = {}) {
  return firstNonEmpty(
    item?.author?.name,
    item?.author?.displayName,
    item?.author?.email,
    item?.process?.docente,
    structuredContent?.docente
  );
}

function formatBitacoraSequence(value = 0) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return "00";
  return String(numeric).padStart(2, "0");
}

function renderStudentSummaryCompact(student) {
  if (!student) {
    return `<div class="empty-state empty-state--files"><p class="empty-state__text">No hay estudiante seleccionado.</p></div>`;
  }

  return `
    <article class="student-summary student-summary--compact">
      <div class="student-summary__identity">
        <p class="student-summary__eyebrow">Estudiante activo</p>
        <h2 class="student-summary__name">${escapeHtml(getStudentName(student))}</h2>
        <p class="student-summary__doc">${escapeHtml(getStudentDocument(student) || "Sin documento")}</p>
      </div>
      <div class="student-summary__aside">
        <div class="student-summary__badges">
          <span class="badge">${escapeHtml(getReadableValue(student.estado))}</span>
          <span class="badge">${escapeHtml(
            getReadableValue(getStudentProcessesSummary(student), "Sin procesos")
          )}</span>
        </div>
        <dl class="student-summary__facts">
          <div class="student-summary__fact">
            <dt>Docente</dt>
            <dd>${escapeHtml(
              getReadableValue(firstNonEmpty(student.docente, student.teacher), "Sin docente")
            )}</dd>
          </div>
          <div class="student-summary__fact">
            <dt>Modalidad</dt>
            <dd>${escapeHtml(getReadableValue(student.modalidad, "Sin modalidad"))}</dd>
          </div>
        </dl>
      </div>
    </article>
  `;
}

function getTeacherOptions(
  teachers = [],
  allStudents = [],
  student,
  selectedTeacher = ""
) {
  const teacherSet = new Set();
  const selected = toStringSafe(selectedTeacher);
  const currentTeacher = toStringSafe(firstNonEmpty(student?.docente, student?.teacher));

  [selected, currentTeacher].filter(Boolean).forEach((item) => teacherSet.add(item));

  teachers.forEach((item) => {
    const teacherName = toStringSafe(firstNonEmpty(item?.nombre, item?.alias, item?.name));
    if (teacherName) {
      teacherSet.add(teacherName);
    }
  });

  allStudents.forEach((item) => {
    const teacher = toStringSafe(firstNonEmpty(item?.docente, item?.teacher));
    if (teacher) {
      teacherSet.add(teacher);
    }
  });

  if (!teacherSet.size) {
    teacherSet.add("No registrado");
  }

  return [...teacherSet];
}

function getCatalogOptions(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((item) => toStringSafe(item)).filter(Boolean))];
}

function renderDatalist(id, values = []) {
  const options = getCatalogOptions(values);
  if (!options.length) return "";

  return `
    <datalist id="${escapeHtml(id)}">
      ${options
        .map(
          (option) => `<option value="${escapeHtml(option)}"></option>`
        )
        .join("")}
    </datalist>
  `;
}

function renderMultiValueField({
  key,
  label,
  inputId,
  listId,
  placeholder = "",
  hint = "Puedes agregar varios items.",
  options = [],
  selectedValues = [],
  }) {
    return `
      <section class="field field--multi-value">
        <span class="field__label">${escapeHtml(label)}</span>
        <div class="multi-value-entry">
        <input
          id="${escapeHtml(inputId)}"
          type="text"
          class="field__input"
            data-multi-input="${escapeHtml(key)}"
            list="${escapeHtml(listId)}"
            placeholder="${escapeHtml(placeholder)}"
          />
        </div>
        <small class="field__hint">${escapeHtml(hint)}</small>
        <div class="multi-value-list" data-multi-values="${escapeHtml(key)}">
          ${renderMultiValueChips(key, selectedValues)}
      </div>
      ${renderDatalist(listId, options)}
    </section>
  `;
}

function renderMultiValueChips(key, values = []) {
  const items = normalizeListValues(values);
  if (!items.length) {
    return `<span class="field__hint">Aun no has agregado items.</span>`;
  }

  return items
    .map(
      (value) => `
        <span class="multi-value-chip" data-multi-item="${escapeHtml(value)}">
          <span>${escapeHtml(value)}</span>
          <button
            type="button"
            class="multi-value-chip__remove"
            data-multi-key="${escapeHtml(key)}"
            data-multi-remove="${escapeHtml(value)}"
            aria-label="Quitar ${escapeHtml(value)}"
          >
            ×
          </button>
        </span>
      `
    )
    .join("");
}

function renderStudentOverridesEditor(
  draft,
  selectedStudents = [],
  catalogOptions = {}
) {
  if (!selectedStudents.length) {
    return `
      <div class="empty-state empty-state--files">
        <p class="empty-state__text">Selecciona estudiantes para habilitar ajustes individuales.</p>
      </div>
    `;
  }

  if (selectedStudents.length < 2) {
    return `
      <div class="empty-state empty-state--files">
        <p class="empty-state__text">Agrega al menos un estudiante mas al grupo para activar ajustes individuales.</p>
      </div>
    `;
  }

  return `
    <div class="student-overrides__header">
      <div>
        <p class="panel-header__eyebrow">Personalizaciones</p>
        <h3 class="panel-header__title">Ajustes por estudiante</h3>
      </div>
      <p class="section-text">
        La bitacora general se aplica a todos. Activa ajustes solo para quien necesite ejercicios, observaciones o tareas diferentes.
      </p>
    </div>
    <div class="student-overrides__list">
      ${selectedStudents
        .map((selectedStudent) =>
          renderStudentOverrideCard(
            selectedStudent,
            getStudentOverrideForDraft(draft, selectedStudent.id),
            catalogOptions
          )
        )
        .join("")}
    </div>
  `;
}

function renderStudentOverrideCard(student, override, catalogOptions = {}) {
  const studentId = toStringSafe(student?.id);
  const selectedOverride = {
    ...buildEmptyStudentOverride(),
    ...(override || {}),
  };

  return `
    <article class="student-override-card ${selectedOverride.enabled ? "is-active" : ""}">
      <label class="student-override-card__toggle">
        <div class="student-override-card__identity">
          <p class="student-override-card__name">${escapeHtml(student?.name || "Estudiante")}</p>
          <p class="student-override-card__meta">${escapeHtml(
            student?.document || studentId || "Sin documento"
          )}</p>
        </div>
        <span class="student-override-card__switch">
          <input
            type="checkbox"
            data-override-enabled="${escapeHtml(studentId)}"
            ${selectedOverride.enabled ? "checked" : ""}
          />
          <span>${selectedOverride.enabled ? "Con ajuste" : "Hereda general"}</span>
        </span>
      </label>
      <div class="student-override-card__body ${selectedOverride.enabled ? "" : "is-hidden"}">
        <label class="field field--compact">
          <span class="field__label">Observacion / tarea personalizada</span>
          <textarea
            class="field__textarea field__textarea--override"
            data-override-textarea="${escapeHtml(studentId)}"
            rows="4"
            placeholder="Ejercicio alternativo, dificultad puntual, tarea especifica..."
          >${escapeHtml(selectedOverride.tareas)}</textarea>
        </label>
        <div class="editor-form-grid editor-form-grid--2">
          ${renderStudentOverrideField(studentId, "etiquetas", "Categorias", "Agrega categorias solo para este estudiante...", selectedOverride.etiquetas, catalogOptions.etiquetas)}
          ${renderStudentOverrideField(studentId, "componenteCorporal", "Componente corporal", "Ejercicios diferenciales...", selectedOverride.componenteCorporal, catalogOptions.componenteCorporal)}
        </div>
        <div class="editor-form-grid editor-form-grid--2">
          ${renderStudentOverrideField(studentId, "componenteTecnico", "Componente tecnico", "Tecnica adaptada...", selectedOverride.componenteTecnico, catalogOptions.componenteTecnico)}
          ${renderStudentOverrideField(studentId, "componenteTeorico", "Componente teorico", "Temas o refuerzos...", selectedOverride.componenteTeorico, catalogOptions.componenteTeorico)}
        </div>
        ${renderStudentOverrideField(studentId, "componenteObras", "Componente de obras", "Obras o repertorio especifico...", selectedOverride.componenteObras, catalogOptions.componenteObras)}
      </div>
    </article>
  `;
}

function renderStudentOverrideField(
  studentId,
  key,
  label,
  placeholder,
  values = [],
  options = []
) {
  const inputKey = `${studentId}:${key}`;
  const listId = `override-${studentId}-${key}-list`;

    return `
      <section class="field field--multi-value field--override">
        <span class="field__label">${escapeHtml(label)}</span>
        <div class="multi-value-entry">
        <input
          type="text"
          class="field__input"
            data-override-input="${escapeHtml(inputKey)}"
            list="${escapeHtml(listId)}"
            placeholder="${escapeHtml(placeholder)}"
          />
        </div>
        <div class="multi-value-list" data-override-values="${escapeHtml(inputKey)}">
          ${renderStudentOverrideChips(studentId, key, values)}
        </div>
      ${renderDatalist(listId, options)}
    </section>
  `;
}

function renderStudentOverrideChips(studentId, key, values = []) {
  const items = normalizeListValues(values);
  if (!items.length) {
    return `<span class="field__hint">Sin ajustes en este campo.</span>`;
  }

  return items
    .map(
      (value) => `
        <span class="multi-value-chip" data-override-item="${escapeHtml(value)}">
          <span>${escapeHtml(value)}</span>
          <button
            type="button"
            class="multi-value-chip__remove"
            data-override-remove="true"
            data-override-student="${escapeHtml(studentId)}"
            data-override-key="${escapeHtml(key)}"
            data-override-value="${escapeHtml(value)}"
            aria-label="Quitar ${escapeHtml(value)}"
          >
            ×
          </button>
        </span>
      `
    )
    .join("");
}

function getStudentOverrideCatalogOptions() {
  const catalogs = cachedCatalogs || getEmptyCatalogs();

  return {
    etiquetas: getCatalogOptions(catalogs.categorias),
    componenteCorporal: getCatalogOptions(catalogs.componenteCorporal),
    componenteTecnico: getCatalogOptions(catalogs.componenteTecnico),
    componenteTeorico: getCatalogOptions(catalogs.componenteTeorico),
    componenteObras: getCatalogOptions(catalogs.componenteObras),
  };
}

function buildAutoTitle(student, fechaClase = "") {
  const safeDate = toStringSafe(fechaClase || getTodayDate());
  const studentName = toStringSafe(getStudentName(student) || "estudiante");
  return `Registro de clase ${safeDate} - ${studentName}`;
}

const STRUCTURED_SECTION_LABELS = new Set([
  "DOCENTE",
  "TAREAS / OBSERVACIONES",
  "COMPONENTE CORPORAL",
  "COMPONENTE TECNICO",
  "COMPONENTE TEORICO",
  "COMPONENTE DE OBRAS",
]);

function isStructuredPlaceholderValue(value) {
  const normalized = normalizeText(value).replace(/:$/, "");
  if (!normalized) return false;

  return [...STRUCTURED_SECTION_LABELS].some(
    (label) => normalizeText(label) === normalized
  );
}

function containsStructuredMarkers(value) {
  const text = String(value || "");
  if (!text.trim()) return false;

  return [...STRUCTURED_SECTION_LABELS].some((label) =>
    text.includes(`${label}:`)
  );
}

function parseStructuredContent(content = "") {
  const text = String(content || "");
  if (!text.trim()) {
    return {
      docente: "",
      tareas: "",
      componenteCorporal: [],
      componenteTecnico: [],
      componenteTeorico: [],
      componenteObras: [],
    };
  }

  const markers = [
    ["DOCENTE", "docente"],
    ["TAREAS / OBSERVACIONES", "tareas"],
    ["COMPONENTE CORPORAL", "componenteCorporal"],
    ["COMPONENTE TECNICO", "componenteTecnico"],
    ["COMPONENTE TEORICO", "componenteTeorico"],
    ["COMPONENTE DE OBRAS", "componenteObras"],
  ];

  const result = {
    docente: "",
    tareas: text.trim(),
    componenteCorporal: [],
    componenteTecnico: [],
    componenteTeorico: [],
    componenteObras: [],
  };

  const hasStructuredMarkers = markers.some(([label]) => text.includes(`${label}:`));
  if (!hasStructuredMarkers) {
    return result;
  }

  markers.forEach(([label, key], index) => {
    const startToken = `${label}:`;
    const start = text.indexOf(startToken);
    if (start === -1) return;

    const contentStart = start + startToken.length;
    let end = text.length;

    for (let cursor = index + 1; cursor < markers.length; cursor += 1) {
      const nextStart = text.indexOf(`${markers[cursor][0]}:`, contentStart);
      if (nextStart !== -1) {
        end = nextStart;
        break;
      }
    }

    const value = text.slice(contentStart, end).trim();
    result[key] =
      key === "docente" || key === "tareas"
        ? value
        : normalizeListValues(value);
  });

  return result;
}

function buildStructuredContent(fields = {}) {
  const normalized = {
    docente: toStringSafe(fields.docente),
    tareas: toStringSafe(fields.tareas),
    componenteCorporal: normalizeListValues(fields.componenteCorporal),
    componenteTecnico: normalizeListValues(fields.componenteTecnico),
    componenteTeorico: normalizeListValues(fields.componenteTeorico),
    componenteObras: normalizeListValues(fields.componenteObras),
  };

  return [
    normalized.docente ? `DOCENTE: ${normalized.docente}` : "",
    normalized.tareas ? `TAREAS / OBSERVACIONES: ${normalized.tareas}` : "",
    normalized.componenteCorporal.length
      ? `COMPONENTE CORPORAL: ${normalized.componenteCorporal.join(", ")}`
      : "",
    normalized.componenteTecnico.length
      ? `COMPONENTE TECNICO: ${normalized.componenteTecnico.join(", ")}`
      : "",
    normalized.componenteTeorico.length
      ? `COMPONENTE TEORICO: ${normalized.componenteTeorico.join(", ")}`
      : "",
    normalized.componenteObras.length
      ? `COMPONENTE DE OBRAS: ${normalized.componenteObras.join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function getStructuredDraftFields(draft, student) {
  const parsed = parseStructuredContent(draft?.contenido || "");
  const safeDocente = containsStructuredMarkers(parsed.docente) ? "" : parsed.docente;
  const safeTareas = containsStructuredMarkers(parsed.tareas) ? "" : parsed.tareas;

  return {
    docente: safeDocente || "",
    tareas: safeTareas || "",
    componenteCorporal: normalizeListValues(parsed.componenteCorporal),
    componenteTecnico: normalizeListValues(parsed.componenteTecnico),
    componenteTeorico: normalizeListValues(parsed.componenteTeorico),
    componenteObras: normalizeListValues(parsed.componenteObras),
  };
}

function normalizeListValues(values = []) {
  const source = Array.isArray(values) ? values : [values];

  return [
    ...new Set(
      source
        .flatMap((value) =>
            String(value || "")
              .split(/,|;|\n/g)
              .map((item) => toStringSafe(item))
          )
          .filter((item) => Boolean(item) && !isStructuredPlaceholderValue(item))
    ),
  ];
}

function buildEmptyStudentOverride() {
  return {
    enabled: false,
    tareas: "",
    etiquetas: [],
    componenteCorporal: [],
    componenteTecnico: [],
    componenteTeorico: [],
    componenteObras: [],
  };
}

function normalizeStudentOverrides(overrides = {}, allowedStudentIds = []) {
  const next = {};
  const allowedIds = new Set(normalizeStudentIds(allowedStudentIds));

  Object.entries(isPlainObject(overrides) ? overrides : {}).forEach(
    ([studentId, value]) => {
      const safeStudentId = toStringSafe(studentId);
      if (!safeStudentId || (allowedIds.size && !allowedIds.has(safeStudentId))) {
        return;
      }

      const source = isPlainObject(value) ? value : {};
      const normalized = {
        enabled: Boolean(source.enabled),
        tareas: toStringSafe(source.tareas),
        etiquetas: normalizeListValues(source.etiquetas),
        componenteCorporal: normalizeListValues(source.componenteCorporal),
        componenteTecnico: normalizeListValues(source.componenteTecnico),
        componenteTeorico: normalizeListValues(source.componenteTeorico),
        componenteObras: normalizeListValues(source.componenteObras),
      };

      if (
        !normalized.enabled &&
        !normalized.tareas &&
        !normalized.etiquetas.length &&
        !normalized.componenteCorporal.length &&
        !normalized.componenteTecnico.length &&
        !normalized.componenteTeorico.length &&
        !normalized.componenteObras.length
      ) {
        return;
      }

      next[safeStudentId] = normalized;
    }
  );

  return next;
}

function getStudentOverrideForDraft(draft, studentId) {
  const overrides = normalizeStudentOverrides(draft?.studentOverrides, [studentId]);
  return {
    ...buildEmptyStudentOverride(),
    ...(overrides[toStringSafe(studentId)] || {}),
  };
}

function joinListValues(values = []) {
  return normalizeListValues(values).join(" • ");
}

function cleanupView() {
  if (unsubscribeView) {
    unsubscribeView();
    unsubscribeView = null;
  }

  viewRoot = null;
  currentNavigateTo = null;
  currentSubscribe = null;
  currentEditorStudentKey = null;
  currentEditorMode = CONFIG?.modes?.individual || "individual";
}

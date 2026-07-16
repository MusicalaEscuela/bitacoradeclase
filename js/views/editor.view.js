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
  removeBitacoraForStudent,
  updateDraft,
  resetDraft,
  setUploadQueue,
  setUploading,
  addUploadedFiles,
  clearUploads,
} from "../state.js";

import {
  getBitacorasByStudentIds,
  createBitacora,
  updateBitacora,
  deleteBitacora,
} from "../api/bitacoras.api.js?v=20260713.2";

import {
  getCatalogs,
  getEmptyCatalogs,
} from "../api/catalogs.api.js";

import { uploadFileResumable } from "../firebase.client.js";
import {
  showSuccess,
  showLoadingToast,
  resolveLoadingToast,
  updateToast,
  dismissToast,
} from "../ui/alerts.ui.js";

import {
  escapeHtml,
  firstNonEmpty,
  formatDisplayDate,
  getReadableValue,
  getStudentDocument,
  getStudentAcademicRecordId,
  getStudentCondition,
  getStudentFallbackId,
  getStudentIdentity,
  getStudentLinkedIds,
  getStudentName,
  getStudentProcessesSummary,
  matchesFlexibleSearch,
  normalizeStudentProcesses,
  resolveStudentProcess,
  getTimestamp,
  getTodayDate,
  isPlainObject,
  normalizeLocalDateInput,
  normalizeBitacorasResponse as normalizeBitacorasResponseShared,
  normalizeText,
  normalizeMode,
  normalizeStudentIds,
  normalizeStudentRefs,
  resolveStudentAcademicRecordIdFromBitacoras,
  resolveStudentRefFromPayload,
  findStudentInCollections,
  toStringSafe,
} from "../utils/shared.js";
import { applyAutomaticCategoriesFromWorks } from "../utils/bitacoras.js";

let viewRoot = null;
let unsubscribeView = null;
let currentNavigateTo = null;
let currentSubscribe = null;
let currentEditorStudentKey = null;
let currentEditorMode = CONFIG?.modes?.individual || "individual";
let currentEditorProcessKey = "";
// Marca si el usuario ya intervino manualmente el campo Docentes (agrego/quito).
// Mientras sea false y el campo este vacio, se inyecta el docente sugerido del proceso.
let docentesTouched = false;
// A partir de cuantos chips se muestra el buscador de items ya agregados.
const MULTI_CHIP_SEARCH_THRESHOLD = 6;
let cachedCatalogs = getEmptyCatalogs();
let catalogsLoadAttempted = false;
let draftInputDebounceTimer = null;
let groupSearchDebounceTimer = null;
let currentEditingBitacoraId = "";
let currentHistorySearchQuery = "";

const DRAFT_INPUT_DEBOUNCE_MS = 140;
const GROUP_SEARCH_DEBOUNCE_MS = 100;
const RECENT_PICKERS_KEY = "bitacoras_recent_pickers_v1";
const RECENT_PICKERS_LIMIT = 12;
// Maximo de opciones que se pintan a la vez en el panel del picker. Evita que
// catalogos enormes (cientos/miles de items) congelen la vista al abrir.
const PICKER_RENDER_LIMIT = 200;

// Identificador sintetico para abrir una bitacora grupal "en blanco": sin
// estudiante principal preseleccionado. El editor lo trata como contexto valido
// para poder renderizarse, pero este id nunca se cuenta como integrante del
// grupo ni se guarda en la bitacora (los integrantes reales se agregan desde el
// buscador interno del editor grupal).
const GROUP_PLACEHOLDER_ID = "__nuevo_grupo__";

function createGroupPlaceholderStudent() {
  return {
    studentKey: GROUP_PLACEHOLDER_ID,
    id: GROUP_PLACEHOLDER_ID,
    studentId: GROUP_PLACEHOLDER_ID,
    nombre: "Bitacora grupal",
    __isGroupPlaceholder: true,
  };
}

function isGroupPlaceholderId(value) {
  return toStringSafe(value) === GROUP_PLACEHOLDER_ID;
}

function isGroupPlaceholderStudent(student) {
  return (
    Boolean(student?.__isGroupPlaceholder) ||
    isGroupPlaceholderId(getStudentIdentity(student))
  );
}

export async function beforeEnter({ payload, navigateTo } = {}) {
  clearAppError();

  const state = getState();
  const access = resolveUserAccess(state?.auth?.user);
  const requestedStudentRef = resolveStudentRefFromPayload(payload);
  const requestedMode = getRequestedModeFromPayload(payload);
  const requestedProcessRef = getRequestedProcessFromPayload(payload);
  const student = getStudentFromState(state, requestedStudentRef);

  if (!student || !canViewStudent(state?.auth?.user, getStudentIdentity(student))) {
    setAppError("No hay un estudiante seleccionado.");
    if (typeof navigateTo === "function") {
      navigateTo(CONFIG.routes.search);
    }
    return;
  }

  currentEditorStudentKey = getStudentIdentity(student);
  currentEditorProcessKey =
    resolveStudentProcess(student, requestedProcessRef)?.processKey || "";

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
  const requestedStudentRef = resolveStudentRefFromPayload(payload);
  const requestedProcessRef = getRequestedProcessFromPayload(payload);
  const student = getStudentFromState(safeState, requestedStudentRef);

  if (!student || !canViewStudent(safeState?.auth?.user, getStudentIdentity(student))) {
    root.innerHTML = renderMissingStudent();
    bindMissingStateEvents();
    setupSubscription(safeConfig, requestedStudentRef);
    return;
  }

  currentEditorStudentKey = getStudentIdentity(student);
  currentEditorProcessKey =
    resolveStudentProcess(student, requestedProcessRef || currentEditorProcessKey)
      ?.processKey || "";
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

  placeTasksAndCategoriesAfterComponents();
  bindEditorEvents(student);
  renderReactiveBlocks(getState(), safeConfig, currentEditorStudentKey);
  setupSubscription(safeConfig, currentEditorStudentKey);
}

export async function afterEnter() {
  const firstField = viewRoot?.querySelector(
    "#bitacora-process-select, #bitacora-fecha, #bitacora-form input:not([type='hidden']):not([type='radio']):not([disabled]), #bitacora-form select:not([disabled]), #bitacora-form textarea:not([disabled])"
  );
  if (firstField) {
    firstField.focus();
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
  // El placeholder grupal no tiene historial propio: no hay nada que cargar.
  if (isGroupPlaceholderStudent(student)) return;

  const studentRef = getStudentIdentity(student);
  if (!studentRef) return;

  const currentItems = getBitacorasFromState(student);
  if (currentItems.length > 0) return;

  setBitacorasLoading(true);

  try {
    const items = await safeLoadBitacoras(student);
    getStudentLinkedIds(student).forEach((linkedStudentId) => {
      setBitacorasForStudent(linkedStudentId, items);
    });
  } catch (error) {
    console.error("Error cargando bitacoras del estudiante:", error);
    setAppError(error?.message || "No se pudieron cargar las bitacoras.");
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
    "Bitacoras de Clase";

  const isGroup = draft.mode === CONFIG.modes.group;

  return `
    <section class="view-shell view-shell--editor">
      <header class="view-header">
        <div class="view-header__content">
          <p class="view-eyebrow">${escapeHtml(title)}</p>
          <h1 class="view-title">Editor de bitacora</h1>
          <p class="view-description">
            Registren observaciones, avances, dificultades y acuerdos de clase sin
            poner al docente a sufrir con una interfaz torpe. Que detalle tan
            revolucionario.
          </p>
        </div>

        <div class="view-header__actions">
          <button
            type="button"
            class="btn btn--ghost"
            id="editor-back-search-btn"
          >
            Volver a busqueda
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
              <h2 class="panel-header__title">Resumen rapido</h2>
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
                <h2 class="panel-header__title">Nueva bitacora</h2>
              </div>
              <p class="section-text">
                El borrador se conserva mientras escriben. Perder texto por un refresh
                sigue siendo una tragedia demasiado comun para 2026.
              </p>
              ${
                !isAuthenticated
                  ? `
                    <div class="message-box message-box--warning">
                      Inicia sesion con Google para consultar el historial y guardar bitacoras en Firebase.
                    </div>
                  `
                  : ""
              }
              ${
                isAuthenticated && !canEditBitacoras
                  ? `
                    <div class="message-box message-box--warning">
                      Tu cuenta no tiene permisos para editar registros en este HUB.
                    </div>
                  `
                  : ""
              }
            </header>

            <form id="bitacora-form" class="bitacora-form" novalidate>
              <div class="form-grid form-grid--modes">
                <fieldset class="field field--radio-group">
                  <legend class="field__label">Tipo de bitacora</legend>

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
                  <span class="field__label">Titulo</span>
                  <input
                    id="bitacora-titulo"
                    name="titulo"
                    type="text"
                    class="field__input"
                    placeholder="Ej: Clase de ritmo y coordinacion"
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
                    demas sin duplicar bitacoras como si fueran panfletos.
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
                    getSelectedStudentsForDraft(draft, student, allStudents),
                    { allowRemoveAll: isGroupPlaceholderStudent(student) }
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
                  placeholder="Ej: ritmo, postura, concentracion"
                  value="${escapeHtml(formatTagsForInput(draft.etiquetas || []))}"
                />
                <small class="field__hint">Separenlas con coma.</small>
              </label>

              <label class="field">
                <span class="field__label">Contenido</span>
                <textarea
                  id="bitacora-contenido"
                  name="contenido"
                  class="field__textarea"
                  rows="10"
                  maxlength="${CONFIG?.limits?.maxBitacoraLength || 8000}"
                  placeholder="Escriban aqui lo trabajado en clase, observaciones, recomendaciones, acuerdos y evolucion del estudiante o grupo."
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
                  accept="image/*,video/*,application/pdf,audio/*"
                  capture="environment"
                />
                <small class="field__hint">
                  Pueden adjuntar imagenes, video, audio o PDF. Si el flujo de uploads
                  todavia no esta completo, al menos queda registro local en el draft.
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
                    ${!isAuthenticated || !canEditBitacoras ? 'data-disabled-by-access="true"' : ""}
                    aria-busy="false"
                  >
                    Guardar bitacora
                  </button>
                </div>
              </div>
            </form>
          </section>

          <section class="card editor-history">
            <header class="editor-history__header">
              <div>
                <p class="panel-header__eyebrow">Historial</p>
                <h2 class="panel-header__title">Bitacoras registradas</h2>
              </div>

              <button
                type="button"
                class="btn btn--ghost btn--sm"
                id="bitacora-refresh-btn"
              >
                Recargar
              </button>
            </header>

            ${renderHistorySearchControl(currentHistorySearchQuery)}
            <div id="bitacoras-history">
              ${renderBitacorasHistory(bitacoras, isLoading, config, isAuthenticated, currentHistorySearchQuery, { hasActiveProcess: Boolean(toStringSafe(currentEditorProcessKey)), totalForStudent: getRawBitacorasFromState(student).length })}
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
  const processSelect = viewRoot.querySelector("#bitacora-process-select");
  const fechaInput = viewRoot.querySelector("#bitacora-fecha");
  const tituloInput = viewRoot.querySelector("#bitacora-titulo");
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
  const historySearchInput = viewRoot.querySelector("#bitacoras-history-search");
  const printBtn = viewRoot.querySelector("#bitacora-print-btn");
  const backSearchBtn = viewRoot.querySelector("#editor-back-search-btn");
  const openProfileBtn = viewRoot.querySelector("#editor-open-profile-btn");
  const modeInputs = viewRoot.querySelectorAll('input[name="modoBitacora"]');
  const groupSearchInput = viewRoot.querySelector("#group-students-search");
  const groupResultsContainer = viewRoot.querySelector("#group-students-results");
  const selectedStudentsContainer = viewRoot.querySelector("#group-selected-students");
  const overridesContainer = viewRoot.querySelector("#student-overrides-block");
  const historyContainer = viewRoot.querySelector("#bitacoras-history");

  [
    fechaInput,
    tituloInput,
    tareasInput,
    contenidoInput,
  ].forEach((input) => {
    if (!input) return;
    input.addEventListener("input", () => scheduleDraftInput(student));
    input.addEventListener("change", () => handleDraftInput(student));
  });

  modeInputs.forEach((input) => {
    input.addEventListener("change", () => {
      handleModeChange(student, input.value);
    });
  });

  if (groupSearchInput) {
    groupSearchInput.addEventListener("input", () => {
      scheduleGroupSearchRender(student);
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

    selectedStudentsContainer.addEventListener("change", (event) => {
      const processSelect = event.target.closest("[data-group-student-process]");
      if (!processSelect) return;

      updateGroupStudentProcess(
        student,
        processSelect.getAttribute("data-group-student-process"),
        processSelect.value
      );
      renderGroupSelectionBlocks(student);
      renderDraftMetaBlock(student);
    });
  }

  if (processSelect) {
    processSelect.addEventListener("change", async () => {
      currentEditorProcessKey = toStringSafe(processSelect.value);
      resetDraftForContext({
        mode: currentEditorMode,
        student,
      });
      refillFormFromDraft(student);
      await reloadHistory(student);
      renderReactiveBlocks(getState(), CONFIG, currentEditorStudentKey);
    });
  }

  if (overridesContainer) {
    overridesContainer.addEventListener("click", (event) => {
      const toggleButton = event.target.closest("button[data-override-enabled]");
      const toggleRow = event.target.closest("[data-override-toggle-row]");
      const toggleTarget = toggleButton || toggleRow;

      if (toggleTarget && overridesContainer.contains(toggleTarget)) {
        event.preventDefault();
        event.stopPropagation();

        const studentId =
          toggleTarget.getAttribute("data-override-enabled") ||
          toggleTarget.getAttribute("data-override-toggle-row");
        const currentDraft = getDraftForContext(student);
        const currentOverride = getStudentOverrideForDraft(currentDraft, studentId);

        toggleStudentOverride(student, studentId, !currentOverride.enabled);
        return;
      }

      const pickerToggle = event.target.closest("[data-override-picker-toggle]");
      if (pickerToggle) {
        event.preventDefault();
        const inputKey = pickerToggle.getAttribute("data-override-picker-toggle");
        const openPanel = viewRoot?.querySelector(
          `[data-override-picker-panel="${CSS.escape(inputKey)}"].is-open`
        );
        if (openPanel) {
          toggleOverridePickerPanel(inputKey, false);
          return;
        }
        const pickerInput = viewRoot?.querySelector(
          `[data-override-input="${CSS.escape(inputKey)}"]`
        );
        // Re-renderiza la lista completa (mas usados arriba) antes de abrir.
        if (pickerInput) {
          renderOverridePickerOptionsForInput(inputKey, pickerInput);
        } else {
          toggleOverridePickerPanel(inputKey);
        }
        return;
      }

      const pickerAdd = event.target.closest("[data-override-picker-add]");
      if (pickerAdd && !pickerAdd.disabled) {
        event.preventDefault();
        const inputKey = pickerAdd.getAttribute("data-override-picker-add");
        const value = pickerAdd.getAttribute("data-override-picker-value");
        addStudentOverrideValue(inputKey, value, student);
        // Tras el re-render, reabrir el panel para seguir eligiendo.
        toggleOverridePickerPanel(inputKey, true);
        return;
      }

      const editButton = event.target.closest("[data-override-edit]");
      if (editButton) {
        startEditOverrideChip(
          {
            studentId: editButton.getAttribute("data-override-student"),
            key: editButton.getAttribute("data-override-key"),
            value: editButton.getAttribute("data-override-value"),
          },
          student
        );
        return;
      }

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

    overridesContainer.addEventListener("change", (event) => {
      const checkbox = event.target.closest('input[type="checkbox"][data-override-enabled]');
      if (checkbox) {
        const studentId = checkbox.getAttribute("data-override-enabled");
        toggleStudentOverride(student, studentId, Boolean(checkbox.checked));
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
        scheduleDraftInput(student);
        return;
      }

      const chipSearch = event.target.closest("[data-override-chip-search]");
      if (chipSearch) {
        filterOverrideChips(
          chipSearch.getAttribute("data-override-chip-search"),
          chipSearch.value
        );
        return;
      }

      const input = event.target.closest("[data-override-input]");
      if (!input) return;

      const inputKey = input.getAttribute("data-override-input");
      renderOverridePickerOptionsForInput(inputKey, input);

      const options = getOverrideFieldOptions(inputKey, input);
      if (matchesCatalogOption(input.value, options)) {
        addStudentOverrideValue(inputKey, input.value, student);
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

  }

  if (archivosInput) {
    archivosInput.addEventListener("change", (event) =>
      handleFilesChange(event, student, "support")
    );
  }

  const multiInputKeys = [
    "docentes",
    "etiquetas",
    "componenteCorporal",
    "componenteTecnico",
    "componenteTeorico",
    "componenteObras",
  ];

  multiInputKeys.forEach((key) => {
    const input = viewRoot.querySelector(`[data-multi-input="${key}"]`);
    if (!input) return;

    // Al enfocar el campo se despliega la lista completa del componente (sin
    // necesidad de escribir ni de tocar "Opciones"). Mientras el campo no se
    // toque la lista permanece cerrada para no generar ruido visual.
    // Los campos de entrada directa (docentes) usan datalist nativo y no tienen
    // panel propio, asi que renderPickerOptionsForInput es un no-op para ellos.
    input.addEventListener("focus", () => {
      renderPickerOptionsForInput(key, input);
    });

    input.addEventListener("input", () => {
      renderPickerOptionsForInput(key, input);
      const options = getMultiFieldOptions(key, input);
      if (matchesCatalogOption(input.value, options)) {
        addMultiValueSelection(key, input.value, student);
      }
    });

    input.addEventListener("change", () => {
      const options = getMultiFieldOptions(key, input);
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

  // Cierra cualquier panel de opciones abierto cuando se hace clic fuera del
  // campo correspondiente, para que la lista no quede flotando ocupando espacio.
  viewRoot.addEventListener("click", (event) => {
    const insideField = event.target.closest(".field--multi-value");
    viewRoot.querySelectorAll("[data-picker-panel].is-open").forEach((panel) => {
      if (insideField && insideField.contains(panel)) return;
      panel.classList.remove("is-open");
    });
  });

  // Boton "Opciones": despliega la lista completa del componente. (Antes este
  // handler estaba mal ubicado dentro de removeDraftFile y no se registraba en
  // un render normal, por eso el boton no hacia nada.)
  viewRoot.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-picker-toggle]");
    if (toggle) {
      const key = toggle.getAttribute("data-picker-toggle");
      const input = viewRoot.querySelector(`[data-multi-input="${key}"]`);
      // Re-renderiza con la lista completa (query actual del input) y abre.
      if (input) {
        renderPickerOptionsForInput(key, input);
      } else {
        togglePickerPanel(key, true);
      }
      return;
    }

    const selectVisible = event.target.closest("[data-picker-select-visible]");
    if (selectVisible) {
      setVisiblePickerChecks(
        selectVisible.getAttribute("data-picker-select-visible"),
        true
      );
      return;
    }

    const addPending = event.target.closest("[data-picker-add-pending]");
    if (addPending && !addPending.disabled) {
      event.preventDefault();
      const key = addPending.getAttribute("data-picker-add-pending");
      if (key) addPendingPickerValues(key, student);
      return;
    }
  });

  viewRoot.querySelectorAll("[data-multi-add]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.getAttribute("data-multi-add");
      const input = viewRoot.querySelector(`[data-multi-input="${key}"]`);
      if (!key || !input) return;
      addMultiValueSelection(key, input.value, student);
    });
  });

  viewRoot.querySelectorAll("[data-multi-values]").forEach((container) => {
    container.addEventListener("click", (event) => {
      const editButton = event.target.closest("[data-multi-edit]");
      if (editButton) {
        const key = editButton.getAttribute("data-multi-key");
        const value = editButton.getAttribute("data-multi-edit");
        if (!key || value === null) return;
        startEditMultiValueChip(key, value, student);
        return;
      }

      const button = event.target.closest("[data-multi-remove]");
      if (!button) return;

      const key = button.getAttribute("data-multi-key");
      const value = button.getAttribute("data-multi-remove");
      if (!key || !value) return;

      removeMultiValueSelection(key, value, student);
    });
  });

  viewRoot.querySelectorAll("[data-chip-search]").forEach((searchInput) => {
    searchInput.addEventListener("input", () => {
      const key = searchInput.getAttribute("data-chip-search");
      if (!key) return;
      filterMultiValueChips(key, searchInput.value);
    });
  });

  viewRoot.querySelectorAll("[data-picker-options]").forEach((container) => {
    container.addEventListener("click", (event) => {
      const toggleButton = event.target.closest("[data-picker-toggle-option]");
      if (toggleButton) {
        const key = toggleButton.getAttribute("data-picker-toggle-option");
        const value = toggleButton.getAttribute("data-picker-value");
        if (!key || !value) return;
        togglePickerPendingValue(key, value);
        return;
      }

      const addButton = event.target.closest("[data-picker-add-option]");
      if (addButton) {
        const key = addButton.getAttribute("data-picker-add-option");
        const value = addButton.getAttribute("data-picker-value");
        if (!key || !value || addButton.disabled) return;

        const input = viewRoot.querySelector(`[data-multi-input="${key}"]`);
        const currentQuery = input?.value || "";
        addMultiValueSelection(key, value, student);

        if (input) {
          input.value = currentQuery;
          renderPickerOptionsForInput(key, input);
          togglePickerPanel(key, true);
        }
      }
    });
  });

  if (videosInput) {
    videosInput.addEventListener("change", (event) =>
      handleFilesChange(event, student, "video")
    );
  }

  const filesPreview = viewRoot.querySelector("#bitacora-files-preview");
  if (filesPreview) {
    filesPreview.addEventListener("click", (event) => {
      const removeButton = event.target.closest("[data-file-remove-index]");
      if (!removeButton) return;

      removeDraftFile(
        Number(removeButton.getAttribute("data-file-remove-index")),
        student
      );
    });
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

  if (historySearchInput) {
    historySearchInput.addEventListener("input", () => {
      currentHistorySearchQuery = toStringSafe(historySearchInput.value);
      renderHistoryBlock(student);
    });
  }

  if (printBtn) {
    printBtn.addEventListener("click", () => {
      handlePrintHistory(student);
    });
  }

  if (historyContainer) {
    historyContainer.addEventListener("click", (event) => {
      const editButton = event.target.closest("[data-bitacora-edit]");
      if (editButton) {
        loadBitacoraForEditing(student, editButton.getAttribute("data-bitacora-edit"));
        return;
      }

      const deleteButton = event.target.closest("[data-bitacora-delete]");
      if (deleteButton) {
        handleDeleteBitacora(
          student,
          deleteButton.getAttribute("data-bitacora-delete")
        );
      }
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

  renderHistoryBlock(student, state, config);

  refillFormIfNeeded(student);
  renderGroupSelectionBlocks(student);
  renderStudentOverridesBlock(student);
  renderFilesPreviewBlock(student);
  renderDraftMetaBlock(student);
  updateSaveButtonState(Boolean(state?.app?.saving));
  syncModeInputs();
}

function placeTasksAndCategoriesAfterComponents() {
  if (!viewRoot) return;

  const categoriesInput = viewRoot.querySelector("#bitacora-etiquetas-input");
  const tasksInput = viewRoot.querySelector("#bitacora-tareas");
  const obrasInput = viewRoot.querySelector("#bitacora-componente-obras-input");
  const categoriesBlock = categoriesInput?.closest(".editor-form-grid");
  const tasksBlock = tasksInput?.closest(".field");
  const componentsBlock = obrasInput?.closest(".editor-form-grid");

  if (!componentsBlock) return;

  if (tasksBlock && tasksBlock !== componentsBlock && componentsBlock.nextElementSibling !== tasksBlock) {
    componentsBlock.insertAdjacentElement("afterend", tasksBlock);
  }

  const anchorBlock = tasksBlock || componentsBlock;
  if (
    categoriesBlock &&
    categoriesBlock !== componentsBlock &&
    categoriesBlock !== tasksBlock &&
    anchorBlock.nextElementSibling !== categoriesBlock
  ) {
    anchorBlock.insertAdjacentElement("afterend", categoriesBlock);
  }
}

function handleDraftInput(student) {
  const draft = updateDraftFromForm(student);
  renderDraftMetaBlock(student);
  return draft;
}

function scheduleDraftInput(student) {
  if (draftInputDebounceTimer) {
    clearTimeout(draftInputDebounceTimer);
  }

  draftInputDebounceTimer = setTimeout(() => {
    handleDraftInput(student);
    draftInputDebounceTimer = null;
  }, DRAFT_INPUT_DEBOUNCE_MS);
}

function scheduleGroupSearchRender(student) {
  if (groupSearchDebounceTimer) {
    clearTimeout(groupSearchDebounceTimer);
  }

  groupSearchDebounceTimer = setTimeout(() => {
    renderGroupSelectionBlocks(student);
    groupSearchDebounceTimer = null;
  }, GROUP_SEARCH_DEBOUNCE_MS);
}

function renderHistoryBlock(student, state = getState(), config = CONFIG) {
  const historyContainer = viewRoot?.querySelector("#bitacoras-history");
  if (!historyContainer) return;

  const hasActiveProcess = Boolean(toStringSafe(currentEditorProcessKey));
  const totalForStudent = getRawBitacorasFromState(student).length;

  // Mantener el titulo del historial sincronizado con el proceso activo.
  const historyTitle = viewRoot?.querySelector("#bitacoras-history-title");
  if (historyTitle) {
    const activeProcess = resolveStudentProcess(student, currentEditorProcessKey);
    const activeProcessLabel = toStringSafe(
      activeProcess?.label || activeProcess?.detalle || activeProcess?.arte || "Proceso"
    );
    historyTitle.textContent = `Bitacoras registradas (${activeProcessLabel})`;
  }

  historyContainer.innerHTML = renderBitacorasHistory(
    getBitacorasFromState(student),
    Boolean(state?.bitacoras?.loading),
    config,
    true,
    currentHistorySearchQuery,
    { hasActiveProcess, totalForStudent }
  );
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

function removeDraftFile(index, student) {
  if (!Number.isInteger(index) || index < 0) return;

  const currentDraft = getDraftForContext(student);
  const currentFiles = Array.isArray(currentDraft.archivos)
    ? currentDraft.archivos
    : [];
  if (!currentFiles[index]) return;

  const removedFile = currentFiles[index];
  if (removedFile.previewUrl && typeof URL !== "undefined") {
    URL.revokeObjectURL(removedFile.previewUrl);
  }

  updateDraft({
    ...currentDraft,
    archivos: currentFiles.filter((_, fileIndex) => fileIndex !== index),
  });

  renderFilesPreviewBlock(student);
  renderDraftMetaBlock(student);
}

function refillFormIfNeeded(student) {
  const draft = getDraftForContext(student);
  const structured = getStructuredDraftFields(draft, student);

  syncInputValue("#bitacora-fecha", normalizeLocalDateInput(draft.fechaClase) || getTodayDate());
  syncInputValue("#bitacora-titulo", draft.titulo || buildAutoTitle(student, draft.fechaClase, draft));
  syncTextareaValue("#bitacora-tareas", structured.tareas || "");
  syncTextareaValue("#bitacora-contenido", draft.contenido || "");
  syncInputValue("#bitacora-docentes-input", "");
  syncInputValue("#bitacora-etiquetas-input", "");
  syncInputValue("#bitacora-componente-corporal-input", "");
  syncInputValue("#bitacora-componente-tecnico-input", "");
  syncInputValue("#bitacora-componente-teorico-input", "");
  syncInputValue("#bitacora-componente-obras-input", "");
  renderMultiValueSelection("docentes", getDraftTeachers(draft, structured, student));
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

  // Mostrar el buscador de chips solo cuando hay varios, y re-aplicar el filtro.
  const safeValues = normalizeListValues(values);
  const searchWrap = viewRoot?.querySelector(`[data-chip-search-wrap="${key}"]`);
  if (searchWrap) {
    searchWrap.classList.toggle(
      "is-hidden",
      safeValues.length <= MULTI_CHIP_SEARCH_THRESHOLD
    );
  }
  const searchInput = viewRoot?.querySelector(`[data-chip-search="${key}"]`);
  if (searchInput && searchInput.value) {
    filterMultiValueChips(key, searchInput.value);
  }
}

// Filtra (oculta) los chips ya agregados que no coincidan con la busqueda.
function filterMultiValueChips(key, query) {
  const needle = normalizeText(query);
  viewRoot
    ?.querySelectorAll(`[data-multi-values="${key}"] [data-multi-item]`)
    .forEach((chip) => {
      const value = normalizeText(chip.getAttribute("data-multi-item"));
      chip.classList.toggle("is-hidden", Boolean(needle) && !value.includes(needle));
    });
}

// Editar un chip: lo quita y coloca su valor en el input para reescribirlo.
function startEditMultiValueChip(key, value, student) {
  const input = viewRoot?.querySelector(`[data-multi-input="${key}"]`);
  removeMultiValueSelection(key, value, student);
  if (!input) return;
  input.value = value;
  input.focus();
  // Para campos con picker, refrescar opciones segun el valor cargado.
  if (key !== "docentes") {
    renderPickerOptionsForInput(key, input);
  }
}

function addMultiValueSelection(key, rawValue, student) {
  const input = viewRoot?.querySelector(`[data-multi-input="${key}"]`);
  const valuesToAdd = normalizeListValues(rawValue);
  if (!valuesToAdd.length) return;

  if (key === "docentes") docentesTouched = true;

  const nextValues = normalizeListValues([
    ...getMultiValueSelection(key),
    ...valuesToAdd,
  ]);

  renderMultiValueSelection(key, nextValues);
  if (input) input.value = "";
  rememberPickerValues(key, valuesToAdd);
  applySuggestedCategoriesFromSelection(key, valuesToAdd, student);
  handleDraftInput(student);
}

function applySuggestedCategoriesFromSelection(key, values = [], student) {
  if (key === "etiquetas" || key === "docentes") return;

  // La categoria configurada explicitamente en Configuracion tiene prioridad;
  // la heuristica por palabras clave queda como respaldo.
  const configured = getConfiguredCategoriesForItems(key, values);
  const inferred = inferCategoriesFromActivities(values, key);
  const suggested = normalizeListValues([...configured, ...inferred]);
  if (!suggested.length) return;

  const nextCategories = normalizeListValues([
    ...getMultiValueSelection("etiquetas"),
    ...suggested,
  ]);
  renderMultiValueSelection("etiquetas", nextCategories);
  rememberPickerValues("etiquetas", suggested);
}

// Lee el mapa { componenteX: { item: categoria } } guardado en Configuracion y
// devuelve las categorias que correspondan a los items recien agregados.
function getConfiguredCategoriesForItems(key, values = []) {
  const catalogs = cachedCatalogs || getEmptyCatalogs();
  const mapping = catalogs.autoCategorias && catalogs.autoCategorias[key];
  if (!mapping || typeof mapping !== "object") return [];

  const lookup = new Map();
  Object.entries(mapping).forEach(([item, category]) => {
    lookup.set(normalizeText(item), category);
  });

  const result = [];
  normalizeListValues(values).forEach((value) => {
    const category = lookup.get(normalizeText(value));
    if (category) result.push(category);
  });

  return normalizeListValues(result);
}

function inferCategoriesFromActivities(values = [], sourceKey = "") {
  const catalogs = cachedCatalogs || getEmptyCatalogs();
  const categories = getCatalogOptions(catalogs.categorias);
  const matches = [];

  normalizeListValues(values).forEach((value) => {
    const normalizedValue = normalizeText(value);
    const lowerValue = normalizedValue.toLowerCase();
    const matchedCategory = categories.find((category) => {
      const normalizedCategory = normalizeText(category);
      return (
        normalizedValue.includes(normalizedCategory) ||
        normalizedCategory.includes(normalizedValue)
      );
    });
    if (matchedCategory) matches.push(matchedCategory);

    if (/\bescala(s)?\b/.test(lowerValue)) {
      matches.push(resolveCategoryLabel(categories, ["Escalas", "Escala"]));
    }

    if (/\britm/.test(lowerValue)) {
      matches.push(resolveCategoryLabel(categories, ["Ritmo"]));
    }

    if (/\bmethod\b|\bmetodo\b|\bm[eé]todo\b/.test(lowerValue)) {
      matches.push(resolveCategoryLabel(categories, ["Método", "Metodo"]));
    }

    if (sourceKey === "componenteObras") {
      matches.push(resolveCategoryLabel(categories, ["Canciones/Obras", "Canciones", "Obras"]));
    }
  });

  return normalizeListValues(matches);
}

function resolveCategoryLabel(categories = [], candidates = []) {
  const normalizedCandidates = normalizeListValues(candidates);
  const found = categories.find((category) => {
    const normalizedCategory = normalizeText(category);
    return normalizedCandidates.some(
      (candidate) => normalizedCategory === normalizeText(candidate)
    );
  });

  return found || normalizedCandidates[0] || "";
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

function getMultiFieldOptions(key, input) {
  const rawOptions = input?.dataset?.multiOptions || "";
  if (rawOptions) {
    try {
      const parsed = JSON.parse(rawOptions);
      if (Array.isArray(parsed)) return parsed.map(toStringSafe).filter(Boolean);
    } catch (error) {
      console.warn("No se pudieron leer opciones del campo:", key, error);
    }
  }

  return getDatalistOptions(input?.getAttribute("list"));
}

function renderPickerOptionsForInput(key, input) {
  const optionsContainer = viewRoot?.querySelector(`[data-picker-options="${key}"]`);
  if (!optionsContainer || !input) return;

  const query = normalizeText(input.value);
  const options = getMultiFieldOptions(key, input);
  // Lista completa (ya viene con los mas usados arriba); el filtro del input
  // es la forma de acotarla.
  const filtered = options.filter(
    (option) => !query || normalizeText(option).includes(query)
  );

  optionsContainer.innerHTML = renderMultiPickerOptions(
    key,
    filtered,
    getMultiValueSelection(key),
    getPendingPickerValues(key)
  );
  togglePickerPanel(key, true);
}

function togglePickerPanel(key, forceOpen = null) {
  const panel = viewRoot?.querySelector(`[data-picker-panel="${key}"]`);
  if (!panel) return;

  const shouldOpen =
    forceOpen === null ? !panel.classList.contains("is-open") : Boolean(forceOpen);
  panel.classList.toggle("is-open", shouldOpen);
}

function setVisiblePickerChecks(key, checked) {
  viewRoot
    ?.querySelectorAll(`[data-picker-option="${key}"]`)
    .forEach((input) => {
      if (!input.closest(".multi-picker-option")?.classList.contains("is-hidden")) {
        input.checked = Boolean(checked);
      }
    });
}

function addCheckedPickerSelections(key, student) {
  const values = [
    ...(viewRoot?.querySelectorAll(`[data-picker-option="${key}"]:checked`) || []),
  ].map((input) => input.value);

  addMultiValueSelection(key, values, student);
  viewRoot
    ?.querySelectorAll(`[data-picker-option="${key}"]:checked`)
    .forEach((input) => {
      input.checked = false;
    });
}

function getPendingPickerValues(key) {
  return [
    ...(viewRoot?.querySelectorAll(`[data-picker-pending="${key}"].is-pending`) || []),
  ]
    .map((item) => toStringSafe(item.getAttribute("data-picker-value")))
    .filter(Boolean);
}

function togglePickerPendingValue(key, value) {
  const option = [
    ...(viewRoot?.querySelectorAll(`[data-picker-pending="${CSS.escape(key)}"]`) || []),
  ].find((item) => toStringSafe(item.getAttribute("data-picker-value")) === value);
  if (!option) return;

  const isPending = option.classList.toggle("is-pending");
  option.setAttribute("aria-pressed", isPending ? "true" : "false");
  option
    .querySelector("[data-picker-action-label]")
    ?.replaceChildren(document.createTextNode(isPending ? "Seleccionada" : "Elegir"));

  updatePendingPickerButton(key);
}

function updatePendingPickerButton(key) {
  const count = getPendingPickerValues(key).length;
  const button = viewRoot?.querySelector(`[data-picker-add-pending="${key}"]`);
  if (!button) return;
  button.disabled = count < 1;
  button.textContent = count ? `Agregar ${count}` : "Agregar seleccionadas";
}

function addPendingPickerValues(key, student) {
  const values = getPendingPickerValues(key);
  if (!values.length) return;

  const input = viewRoot?.querySelector(`[data-multi-input="${key}"]`);
  const selectedBefore = getMultiValueSelection(key).length;
  addMultiValueSelection(key, values, student);
  const selectedAfter = getMultiValueSelection(key).length;
  const addedCount = Math.max(0, selectedAfter - selectedBefore);
  viewRoot
    ?.querySelectorAll(`[data-picker-pending="${key}"]`)
    .forEach((option) => {
      option.classList.remove("is-pending");
      option.setAttribute("aria-pressed", "false");
      option
        .querySelector("[data-picker-action-label]")
        ?.replaceChildren(document.createTextNode("Elegir"));
    });
  updatePendingPickerButton(key);

  if (input) {
    input.value = "";
    renderPickerOptionsForInput(key, input);
    togglePickerPanel(key, false);
  }

  if (addedCount) {
    const itemWord = addedCount === 1 ? "ejercicio" : "ejercicios";
    showSuccess(`${addedCount} ${itemWord} agregados a la bitácora.`);
    // En móvil los chips quedan debajo del selector. Llevamos el foco visual
    // a ese resultado para que la docente confirme de inmediato la acción.
    viewRoot
      ?.querySelector(`[data-multi-values="${key}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function removeMultiValueSelection(key, value, student) {
  if (key === "docentes") docentesTouched = true;
  const nextValues = getMultiValueSelection(key).filter((item) => item !== value);
  renderMultiValueSelection(key, nextValues);
  handleDraftInput(student);
}

function loadBitacoraForEditing(student, bitacoraId, sourceOverride = null) {
  const safeBitacoraId = toStringSafe(bitacoraId);
  if (!safeBitacoraId) return;

  const source =
    sourceOverride ||
    getBitacorasFromState(student).find(
      (item) => toStringSafe(item.id) === safeBitacoraId
    );
  if (!source) {
    setAppError("No se encontro la bitacora para editar.");
    return;
  }

  const normalized = normalizeBitacora(source);
  const studentRef = getStudentIdentity(student);
  const nextMode = getAllowedMode(normalized.mode || CONFIG.modes.individual);
  const nextStudentIds =
    nextMode === CONFIG.modes.group
      ? normalizeStudentIds(normalized.studentIds)
      : [studentRef];

  updateDraft({
    mode: nextMode,
    studentId: studentRef,
    studentKey: student.studentKey || studentRef,
    studentIds: nextStudentIds,
    studentRefs:
      nextMode === CONFIG.modes.group
        ? normalizeStudentRefs(normalized.studentRefs)
        : [{ id: studentRef, name: getStudentName(student) }],
    fechaClase: normalizeLocalDateInput(normalized.fechaClase) || getTodayDate(),
    titulo: normalized.titulo || buildAutoTitle(student, normalized.fechaClase, normalized),
    docentes: normalizeListValues(normalized.docentes || normalized.docente),
    docente: firstNonEmpty(normalized.docente, ...(normalized.docentes || [])),
    etiquetas: normalizeTags(normalized.etiquetas),
    contenido: normalized.contenido || "",
    archivos: normalizeFiles(normalized.archivos || []),
    studentOverrides: normalizeStudentOverrides(
      normalized.studentOverrides,
      nextStudentIds
    ),
    processKey: normalized.processKey || normalized.process?.processKey || "",
    editingBitacoraId: safeBitacoraId,
  });

  currentEditorMode = nextMode;
  currentEditorProcessKey = normalized.processKey || normalized.process?.processKey || "";
  currentEditingBitacoraId = safeBitacoraId;
  // Edicion de bitacora guardada: respetar sus docentes, no inyectar sugerido.
  docentesTouched = true;
  clearAppError();
  refillFormFromDraft(student);
  renderGroupSelectionBlocks(student);
  renderFilesPreviewBlock(student);
  renderDraftMetaBlock(student);
  syncModeInputs();
  updateSaveButtonState(false);
  viewRoot?.querySelector("#bitacora-form")?.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
}

async function handleDeleteBitacora(student, bitacoraId) {
  const safeBitacoraId = toStringSafe(bitacoraId);
  if (!safeBitacoraId) return;

  const source = getBitacorasFromState(student).find(
    (item) => toStringSafe(item.id || item.bitacoraId) === safeBitacoraId
  );
  const title = source?.titulo || source?.title || "esta bitacora";
  const dateLabel = formatDisplayDate(source?.fechaClase || source?.createdAt);
  const confirmed = window.confirm(
    [
      "Estas seguro de eliminar esta bitacora?",
      "",
      title ? `Bitacora: ${title}` : "",
      dateLabel ? `Fecha: ${dateLabel}` : "",
      "",
      "Esta accion no se puede deshacer.",
    ]
      .filter((line) => line !== "")
      .join("\n")
  );

  if (!confirmed) return;

  setAppSaving(true);
  updateSaveButtonState(true);

  try {
    const deleted = await deleteBitacora(safeBitacoraId);
    const relatedStudentIds = normalizeStudentIds(
      deleted?.studentIds || source?.studentIds || [getStudentIdentity(student)]
    );

    relatedStudentIds.forEach((id) => {
      removeBitacoraForStudent(id, safeBitacoraId);
    });

    const fallbackId = getStudentFallbackId(student);
    if (fallbackId) {
      removeBitacoraForStudent(fallbackId, safeBitacoraId);
    }

    if (safeBitacoraId === currentEditingBitacoraId) {
      resetDraftForContext({
        mode: currentEditorMode || CONFIG.modes.individual,
        student,
      });
      refillFormFromDraft(student);
      renderFilesPreviewBlock(student);
      renderDraftMetaBlock(student);
      syncModeInputs();
    }
  } catch (error) {
    console.error("Error eliminando bitacora:", error);
    setAppError(error?.message || "No se pudo eliminar la bitacora.");
  } finally {
    setAppSaving(false);
    updateSaveButtonState(false);
  }
}

async function handleSubmit(student) {
  clearAppError();
  if (getState()?.app?.saving) return;

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

  let draft = updateDraftFromForm(student);
  const validation = validateDraft(draft, student);

  if (!validation.valid) {
    setAppError(validation.message);
    return;
  }

  setAppSaving(true);
  updateSaveButtonState(true);

  let loadingToastId = null;

  try {
    let editingBitacoraId = toStringSafe(
      draft.editingBitacoraId || currentEditingBitacoraId
    );

    if (!editingBitacoraId) {
      const duplicatePayload = buildBitacoraPayload(student, draft);
      const duplicate = await findPotentialDuplicateBitacora(student, duplicatePayload);
      if (duplicate) {
        if (!confirmDuplicateBitacora(duplicate)) {
          return;
        }

        editingBitacoraId = toStringSafe(duplicate.id || duplicate.bitacoraId);
        currentEditingBitacoraId = editingBitacoraId;
      }
    }

    const isUpdating = Boolean(editingBitacoraId);
    loadingToastId = showLoadingToast(
      isUpdating
        ? "Estamos actualizando la bitácora."
        : "Estamos guardando la bitácora.",
      { title: isUpdating ? "Actualizando" : "Guardando" }
    );

    const hasPendingFiles = (Array.isArray(draft?.archivos) ? draft.archivos : []).some(
      (item) => item?.sourceFile instanceof File && !item?.url
    );
    if (hasPendingFiles && loadingToastId) {
      updateToast(loadingToastId, {
        title: "Subiendo archivos",
        message: "Estamos cargando los archivos adjuntos.",
      });
    }

    draft = await uploadDraftFilesToStorage(student, draft);
    draft = {
      ...draft,
      editingBitacoraId,
    };
    const payload = buildBitacoraPayload(student, draft);
    const saved = editingBitacoraId
      ? await updateBitacora(editingBitacoraId, payload)
      : await createBitacora(payload);
    const normalized = normalizeCreatedBitacora(saved, payload);

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
    clearUploads();

    if (loadingToastId) {
      resolveLoadingToast(loadingToastId, {
        type: "success",
        title: "Listo",
        message: editingBitacoraId
          ? "La bitácora se actualizó correctamente."
          : "La bitácora se guardó correctamente.",
      });
      loadingToastId = null;
    }
  } catch (error) {
    console.error("Error guardando bitacora:", error);
    setAppError(
      error?.message ||
        CONFIG?.text?.saveError ||
        "No se pudo guardar la bitacora."
    );

    if (loadingToastId) {
      resolveLoadingToast(loadingToastId, {
        type: "error",
        title: "No se pudo guardar",
        message:
          error?.message ||
          CONFIG?.text?.saveError ||
          "No se pudo guardar la bitácora.",
      });
      loadingToastId = null;
    }
  } finally {
    if (loadingToastId) {
      dismissToast(loadingToastId);
    }
    setAppSaving(false);
    updateSaveButtonState(false);
  }
}

function updateSaveButtonState(isSaving) {
  const button = viewRoot?.querySelector("#bitacora-save-btn");
  if (!button) return;

  const isEditing = Boolean(
    toStringSafe(getCurrentDraft()?.editingBitacoraId || currentEditingBitacoraId)
  );
  button.disabled = Boolean(isSaving) || button.hasAttribute("data-disabled-by-access");
  button.classList.toggle("is-loading", Boolean(isSaving));
  button.setAttribute("aria-busy", isSaving ? "true" : "false");
  button.textContent = isSaving
    ? "Guardando..."
    : isEditing
    ? "Actualizar bitacora"
    : "Guardar bitacora";
}

function sanitizePathPart(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function buildStorageUploadPath(student, file, kind = "support", index = 0) {
  const studentId = sanitizePathPart(getStudentIdentity(student) || "sin-estudiante");
  const timestamp = Date.now();
  const safeKind = sanitizePathPart(kind || "support");
  const originalName = sanitizePathPart(file?.name || `archivo-${index + 1}`);
  return `bitacoras/${studentId}/${timestamp}-${safeKind}-${index + 1}-${originalName}`;
}

async function uploadDraftFilesToStorage(student, draft = {}) {
  const files = Array.isArray(draft?.archivos) ? draft.archivos : [];
  if (!files.length) return draft;

  const pending = files.filter(
    (item) => item?.sourceFile instanceof File && !item?.url
  );
  if (!pending.length) return draft;

  setUploading(true);

  try {
    const uploaded = [];

    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index];
      const file = item.sourceFile;
      const path = buildStorageUploadPath(student, file, item.kind, index);
      const result = await uploadFileResumable(path, file);

      uploaded.push({
        name: result?.name || item?.name || `Archivo ${index + 1}`,
        type: result?.type || item?.type || "",
        size: Number(result?.size || item?.size || 0),
        url: result?.url || "",
        path: result?.path || path,
        kind: item?.kind || "support",
        uploadedAt: new Date().toISOString(),
      });
    }

    const existing = files
      .filter((item) => item?.url || item?.path)
      .map((item) => ({
        name: item?.name || "Archivo",
        type: item?.type || "",
        size: Number(item?.size || 0),
        url: item?.url || "",
        path: item?.path || "",
        kind: item?.kind || "support",
        uploadedAt: item?.uploadedAt || null,
      }));

    const nextDraft = {
      ...draft,
      archivos: [...existing, ...uploaded],
    };

    updateDraft(nextDraft);
    addUploadedFiles(uploaded);
    setUploadQueue([]);

    return nextDraft;
  } finally {
    setUploading(false);
  }
}

async function reloadHistory(student) {
  const studentRef = getStudentIdentity(student);
  if (!studentRef) return;

  setBitacorasLoading(true);
  const loadingToastId = showLoadingToast("Estamos actualizando el historial.", {
    title: "Sincronizando",
  });

  try {
    clearAppError();
    const items = await safeLoadBitacoras(student);
    getStudentLinkedIds(student).forEach((linkedStudentId) => {
      setBitacorasForStudent(linkedStudentId, items);
    });

    resolveLoadingToast(loadingToastId, {
      type: "success",
      title: "Historial actualizado",
      message: "El historial está al día.",
    });
  } catch (error) {
    console.error("Error recargando historial:", error);
    setAppError(error?.message || "No se pudo recargar el historial.");
    resolveLoadingToast(loadingToastId, {
      type: "error",
      title: "No se pudo actualizar",
      message: error?.message || "No se pudo recargar el historial.",
    });
  } finally {
    setBitacorasLoading(false);
  }
}

async function findPotentialDuplicateBitacora(student, payload = {}) {
  const relatedIds = new Set(
    normalizeStudentIds([
      ...(payload.studentIds || [payload.studentId]),
      ...getStudentLinkedIds(student),
    ])
  );
  if (!relatedIds.size) return null;

  let items = [
    ...getBitacorasFromState(student),
    ...[...relatedIds].flatMap((studentId) => getBitacorasFromState(studentId)),
  ];
  items = dedupeBitacorasById(items);
  if (!items.length) {
    try {
      items = await safeLoadBitacoras(student);
    } catch (error) {
      console.warn("No se pudo consultar historial para validar duplicados:", error);
      return null;
    }
  }

  const targetDate = normalizeClassDate(payload.fechaClase);
  const targetTeacher = normalizeDuplicateToken(payload.process?.docente);
  const targetProcess = normalizeDuplicateProcess(payload);

  if (!targetDate) return null;

  return items.find((item) => {
    const itemStudentIds = normalizeStudentIds(item.studentIds || [item.studentId]);
    const hasSameStudent = itemStudentIds.some((id) => relatedIds.has(id));
    if (!hasSameStudent) return false;

    if (normalizeClassDate(item.fechaClase) !== targetDate) return false;

    const itemTeacher = normalizeDuplicateToken(
      item?.process?.docente || item?.docente || item?.teacher
    );
    if (targetTeacher && itemTeacher && itemTeacher !== targetTeacher) return false;

    const itemProcess = normalizeDuplicateProcess(item);
    if (targetProcess && itemProcess && itemProcess !== targetProcess) return false;

    return true;
  }) || null;
}

function dedupeBitacorasById(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const key = toStringSafe(item?.id || item?.bitacoraId);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function confirmDuplicateBitacora(duplicate = {}) {
  const dateLabel = formatDisplayDate(duplicate.fechaClase || duplicate.createdAt);
  const processLabel = firstNonEmpty(
    duplicate?.process?.processLabel,
    duplicate?.process?.programa,
    duplicate?.process?.area,
    duplicate?.processKey
  );
  const teacherLabel = firstNonEmpty(
    duplicate?.process?.docente,
    duplicate?.docente,
    duplicate?.teacher
  );

  const details = [
    dateLabel ? `Fecha: ${dateLabel}` : "",
    processLabel ? `Proceso: ${processLabel}` : "",
    teacherLabel ? `Docente: ${teacherLabel}` : "",
  ].filter(Boolean);

  return window.confirm(
    [
      "Ya existe una bitacora muy parecida para este estudiante.",
      "",
      ...details,
      "",
      "Quieres editar esa bitacora existente en lugar de crear otra?",
    ].join("\n")
  );
}

function normalizeClassDate(value = "") {
  const raw = toStringSafe(value);
  if (!raw) return "";
  return raw.includes("T") ? raw.slice(0, 10) : raw;
}

function normalizeDuplicateToken(value = "") {
  return normalizeText(value);
}

function normalizeDuplicateProcess(item = {}) {
  return normalizeText(
    firstNonEmpty(
      item?.process?.processKey,
      item?.processKey,
      item?.process?.processLabel,
      item?.process?.programa,
      item?.process?.area
    )
  );
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
            <p class="report-kicker">Musicala  -  Historial pedagogico</p>
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
    item.studentRefs.map((student) => student.name || student.id || "Estudiante").join("  -  ")
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
        override.processKey ? `Proceso: ${getProcessLabelForStudentOverride(item, studentId, override.processKey)}` : "",
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
  return renderPrintableSection("Personalizacion por estudiante", blocks.join("\n"));
}

async function safeLoadBitacoras(studentOrRef) {
  const linkedStudentIds =
    studentOrRef && typeof studentOrRef === "object"
      ? getStudentLinkedIds(studentOrRef)
      : normalizeStudentIds([studentOrRef]);
  const response = await getBitacorasByStudentIds(linkedStudentIds, {
    processKey: currentEditorProcessKey || "",
  });
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
    titulo: item.titulo || item.title || "Bitacora sin titulo",
    contenido: item.contenido || item.content || "",
    etiquetas: normalizeTags(item.etiquetas || item.tags || []),
    docentes: normalizeListValues(item.docentes || item.docente || item.process?.docente),
    docente: firstNonEmpty(item.docente, item.process?.docente),
    fechaClase: normalizeLocalDateInput(item.fechaClase || item.fecha || item.classDate || ""),
    archivos: normalizeFiles(item.archivos || item.attachments || []),
    studentIds: normalizeStudentIds(item.studentIds || [item.studentId]),
    studentRefs: normalizeStudentRefs(item.studentRefs || []),
    studentOverrides: normalizeStudentOverrides(
      item.studentOverrides || item.overrides,
      normalizeStudentIds(item.studentIds || [item.studentId])
    ),
    createdAt: item.createdAt || item.created_at || item.fechaRegistro || "",
    author: item.author || null,
    process: item.process || {},
    processKey:
      toStringSafe(item?.process?.processKey) ||
      toStringSafe(item?.processKey),
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
  const allStudents = getAllStudentsFromState(getState());
  const selectedStudents = getSelectedStudentsForDraft(draft, student, allStudents);

  // Si la bitacora grupal se abrio en blanco (placeholder), el "estudiante
  // principal" para metadatos (proceso, area, sede) es el primer integrante real
  // agregado. Asi el payload nunca queda asociado al id sintetico.
  if (isGroupPlaceholderStudent(student)) {
    const firstId = selectedStudents[0]?.id;
    const firstStudent =
      (firstId &&
        allStudents.find((item) => getStudentIdentity(item) === firstId)) ||
      null;
    student = firstStudent || createGroupPlaceholderStudent();
  }

  const studentRef = getStudentIdentity(student);
  const hasGroupSelection = selectedStudents.length > 1;
  const mode =
    getAllowedMode(draft.mode) === CONFIG.modes.group || hasGroupSelection
      ? CONFIG.modes.group
      : CONFIG.modes.individual;
  const structured = getStructuredDraftFields(draft, student);
  const selectedTeachers = normalizeListValues([
    ...(Array.isArray(draft.docentes) ? draft.docentes : []),
    structured.docentes,
    structured.docente,
  ]);
  const selectedTeacher = selectedTeachers[0] || "";
  const activeProcess =
    resolveStudentProcess(student, currentEditorProcessKey || draft.processKey) ||
    normalizeStudentProcesses(student)[0] ||
    null;

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

  const studentAcademicRefs = selectedStudents.map((item) => ({
    canonicalStudentId: item.id,
    academicRecordId: item.academicRecordId || item.id,
    linkedStudentIds: normalizeStudentIds(
      item.linkedStudentIds || [item.id]
    ),
  }));
  const linkedStudentIds = normalizeStudentIds(
    studentAcademicRefs.flatMap((item) => item.linkedStudentIds)
  );
  const primaryAcademicRef =
    studentAcademicRefs.find((item) => item.canonicalStudentId === studentRef) ||
    studentAcademicRefs[0] ||
    null;
  const resolvedPrimaryAcademicId =
    mode === CONFIG.modes.individual
      ? resolveStudentAcademicRecordIdFromBitacoras(
          student,
          getBitacorasFromState(student)
        )
      : primaryAcademicRef?.academicRecordId;

  return applyAutomaticCategoriesFromWorks({
    mode,
    studentId: studentRef,
    studentKey: student.studentKey || studentRef,
    studentIds,
    studentRefs,
    primaryStudentId: studentRef,
    academicRecordId:
      resolvedPrimaryAcademicId ||
      getStudentAcademicRecordId(student),
    linkedStudentIds,
    studentAcademicRefs,
    title: String(
      draft.titulo ||
        buildAutoTitle(student, draft.fechaClase, { mode, studentRefs })
    ).trim(),
    content: String(draft.contenido || "").trim(),
    tags: normalizeTags(draft.etiquetas),
    fechaClase: normalizeLocalDateInput(draft.fechaClase) || getTodayDate(),
    docentes: selectedTeachers,
    docente: selectedTeacher,
    attachments: normalizeFiles(draft.archivos),
    archivos: normalizeFiles(draft.archivos),
    studentOverrides:
      mode === CONFIG.modes.group
        ? buildGroupStudentOverridesForPayload(draft, studentIds, allStudents)
        : normalizeStudentOverrides(draft.studentOverrides, studentIds),
    processKey: activeProcess?.processKey || "",
    process: {
      processKey: activeProcess?.processKey || "",
      processLabel: firstNonEmpty(
        activeProcess?.label,
        activeProcess?.detalle,
        activeProcess?.arte
      ),
      area: firstNonEmpty(
        activeProcess?.arte,
        student.area,
        student.programa,
        student.instrumento
      ),
      modalidad: firstNonEmpty(student.modalidad),
      docente: selectedTeacher,
      sede: firstNonEmpty(student.sede),
      programa: firstNonEmpty(
        activeProcess?.detalle,
        activeProcess?.label,
        student.programa,
        student.area
      ),
    },
    author: buildAuthorFromState(),
    createdAt: new Date().toISOString(),
  });
}

function validateDraft(draft, student) {
  if (!draft) {
    return { valid: false, message: "No hay informacion para guardar." };
  }

  if (!String(draft.fechaClase || "").trim()) {
    return { valid: false, message: "La fecha de clase es obligatoria." };
  }

  if (!String(draft.titulo || "").trim()) {
    return { valid: false, message: "El titulo es obligatorio." };
  }

  if (!String(draft.contenido || "").trim()) {
    return { valid: false, message: "La bitacora no puede quedar vacia." };
  }

  const maxLength = CONFIG?.limits?.maxBitacoraLength || 8000;
  if (String(draft.contenido || "").length > maxLength) {
    return {
      valid: false,
      message: `La bitacora supera el maximo de ${maxLength} caracteres.`,
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
          "La bitacora grupal requiere al menos dos estudiantes.",
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

    const toggleControl = viewRoot?.querySelector(
      `[data-override-enabled="${studentId}"]`
    );
    const enabled =
      toggleControl?.matches?.('input[type="checkbox"]')
        ? Boolean(toggleControl.checked)
        : toggleControl?.getAttribute("aria-pressed") === "true";

    if (!enabled) {
      return;
    }

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

  const requestedMode = getAllowedMode(
    viewRoot?.querySelector('input[name="modoBitacora"]:checked')?.value ||
      existingDraft.mode ||
      CONFIG.modes.individual
  );

  const selectedStudentsForRequestedMode = getSelectedStudentsForDraft(
    {
      ...existingDraft,
      mode: requestedMode,
    },
    student,
    getAllStudentsFromState(getState())
  );
  const preservedGroupIds = normalizeStudentIds(existingDraft.studentIds || []);
  const nextMode =
    requestedMode === CONFIG.modes.group ||
    selectedStudentsForRequestedMode.length > 1 ||
    preservedGroupIds.length > 1
      ? CONFIG.modes.group
      : CONFIG.modes.individual;
  const selectedStudents = getSelectedStudentsForDraft(
    {
      ...existingDraft,
      mode: nextMode,
      studentIds:
        nextMode === CONFIG.modes.group && preservedGroupIds.length > 1
          ? preservedGroupIds
          : existingDraft.studentIds,
    },
    student,
    getAllStudentsFromState(getState())
  );

  const structuredFields = {
    docentes: getMultiValueSelection("docentes"),
    tareas: viewRoot?.querySelector("#bitacora-tareas")?.value || "",
    componenteCorporal: getMultiValueSelection("componenteCorporal"),
    componenteTecnico: getMultiValueSelection("componenteTecnico"),
    componenteTeorico: getMultiValueSelection("componenteTeorico"),
    componenteObras: getMultiValueSelection("componenteObras"),
  };

  const nextFecha = normalizeLocalDateInput(viewRoot?.querySelector("#bitacora-fecha")?.value || "");
  const nextTitulo = buildAutoTitle(student, nextFecha, {
    mode: nextMode,
    studentRefs: selectedStudents.map((item) => ({ id: item.id, name: item.name })),
  });
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
    docentes: structuredFields.docentes,
    docente: structuredFields.docentes[0] || "",
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
  syncModeInputs();
  return nextDraft;
}

/**
 * Devuelve la lista de docentes del draft, inyectando el docente sugerido del
 * proceso (defaultDraft) solo si el campo esta vacio y el usuario no lo ha
 * intervenido manualmente todavia (docentesTouched). Asi el sugerido aparece al
 * crear/reiniciar la bitacora pero no reaparece si el usuario lo quito.
 */
function resolveDraftTeachersWithSuggestion(draft = {}, defaultDraft = {}) {
  const current = normalizeListValues(draft.docentes || draft.docente);
  if (current.length) return current;
  if (docentesTouched) return [];
  return normalizeListValues(defaultDraft.docentes || defaultDraft.docente);
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
    fechaClase: normalizeLocalDateInput(draft.fechaClase) || getTodayDate(),
    titulo: draft.titulo || "",
    docentes: resolveDraftTeachersWithSuggestion(draft, defaultDraft),
    docente: firstNonEmpty(
      ...resolveDraftTeachersWithSuggestion(draft, defaultDraft),
      draft.docente
    ),
    etiquetas: Array.isArray(draft.etiquetas) ? draft.etiquetas : [],
    contenido: draft.contenido || "",
    archivos: normalizeFiles(draft.archivos || []),
    studentOverrides: normalizeStudentOverrides(draft.studentOverrides, baseStudentRefs.map((item) => item.id)),
  };
}

function getInitialGroupRefsFromSelection() {
  const state = getState();
  const selectedIds = normalizeStudentIds(state?.search?.selectedStudentIds || []);
  if (!selectedIds.length) return [];

  const allStudents = getAllStudentsFromState(state);
  return selectedIds
    .filter((id) => !isGroupPlaceholderId(id))
    .map((id) => {
      const found = allStudents.find(
        (item) => getStudentIdentity(item) === id
      );
      return { id, name: found ? getStudentName(found) : id };
    });
}

function createDefaultDraft(studentRef, student, mode = CONFIG.modes.individual) {
  const normalizedMode = getAllowedMode(mode);
  const baseStudentName = isPlainObject(student) ? getStudentName(student) : "";
  const activeProcess =
    resolveStudentProcess(student, currentEditorProcessKey) ||
    normalizeStudentProcesses(student)[0] ||
    null;
  // Bitacora grupal en blanco: no hay estudiante base real. Los integrantes
  // iniciales son los que el docente hubiera preseleccionado en la busqueda
  // (puede ser ninguno); el resto se agrega desde el buscador interno.
  const isPlaceholder = isGroupPlaceholderStudent(student);
  const placeholderRefs = isPlaceholder
    ? getInitialGroupRefsFromSelection()
    : [];

  const refs = isPlaceholder
    ? placeholderRefs
    : [
        {
          id: studentRef,
          name: baseStudentName,
        },
      ];
  // En grupal, si no hay docente en el proceso/estudiante base, usar el del usuario en sesion.
  const sessionUser = getState()?.auth?.user || null;
  const sessionTeacher =
    normalizedMode === CONFIG.modes.group
      ? firstNonEmpty(sessionUser?.name, sessionUser?.displayName)
      : "";
  const suggestedTeacher = firstNonEmpty(
    activeProcess?.docente,
    activeProcess?.teacher,
    student?.docente,
    student?.teacher,
    student?.profesor,
    student?.docenteNombre,
    sessionTeacher
  );

  return {
    mode: normalizedMode,
    studentId: studentRef || "",
    studentKey: isPlainObject(student) ? student.studentKey || studentRef : studentRef,
    studentIds: refs.map((item) => item.id).filter(Boolean),
    studentRefs: refs.filter((item) => item.id),
    processKey: activeProcess?.processKey || "",
    fechaClase: getTodayDate(),
    titulo: "",
    docentes: normalizeListValues(suggestedTeacher),
    docente: suggestedTeacher,
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

  // El editor grupal en blanco (placeholder) es dueño de cualquier borrador
  // grupal: al normalizarse en el estado, los borradores grupales quedan con
  // studentId null, asi que la comparacion por ids nunca coincidiria y el
  // borrador se descartaba en cada render (los integrantes "desaparecian").
  if (
    isGroupPlaceholderId(studentRef) &&
    getAllowedMode(draft.mode) === CONFIG.modes.group
  ) {
    return true;
  }

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
  const activeProcess =
    resolveStudentProcess(student, currentEditorProcessKey) ||
    normalizeStudentProcesses(student)[0] ||
    null;
  const nextDraft = createDefaultDraft(studentRef, student, mode);
  nextDraft.processKey = activeProcess?.processKey || "";

  resetDraft(nextDraft);
  clearUploads();
  currentEditingBitacoraId = "";
  currentEditorMode = getAllowedMode(mode);
  // Reinicio del formulario / cambio de proceso: vuelve a permitir el docente sugerido.
  docentesTouched = false;
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
          (file, index) => `
            <article class="file-chip">
              ${renderFileThumbnail(file, "file-chip__thumb")}
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
                      .join("  -  ")
                  )}
                </p>
              </div>
              <button
                type="button"
                class="file-chip__remove"
                data-file-remove-index="${index}"
                aria-label="Quitar ${escapeHtml(file.name || file.nombre || "archivo")}"
              >
                x
              </button>
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
        ${renderStudentStatusDot(student)}
        <h2 class="student-summary__name">${escapeHtml(getStudentName(student))}</h2>
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

function renderHistorySearchControl(value = "") {
  return `
    <label class="history-search field">
      <span class="field__label">Buscar en bitacoras</span>
      <input
        id="bitacoras-history-search"
        type="search"
        class="field__input"
        value="${escapeHtml(value)}"
        placeholder="Busca tecnica, ritmo, obra, tarea, docente o fecha..."
        autocomplete="off"
      />
    </label>
  `;
}

function renderBitacorasHistory(
  items = [],
  isLoading = false,
  config,
  isAuthenticated = true,
  searchQuery = "",
  meta = {}
) {
  const hasActiveProcess = Boolean(meta?.hasActiveProcess);
  const totalForStudent = Number(meta?.totalForStudent || 0);
  if (!isAuthenticated) {
    return `
      <div class="empty-state">
        <p class="empty-state__title">Historial protegido</p>
        <p class="empty-state__text">
          Inicia sesion con Google para ver las bitacoras guardadas de este estudiante.
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
    // Mensajes vacios mas claros segun el contexto del proceso activo.
    if (hasActiveProcess && totalForStudent > 0) {
      return `
        <div class="empty-state">
          <p class="empty-state__title">Sin bitacoras en este proceso</p>
          <p class="empty-state__text">
            Hay bitacoras del estudiante, pero ninguna corresponde al proceso seleccionado.
          </p>
        </div>
      `;
    }

    if (hasActiveProcess) {
      return `
        <div class="empty-state">
          <p class="empty-state__title">Sin bitacoras en este proceso</p>
          <p class="empty-state__text">
            No hay bitacoras registradas para este proceso.
          </p>
        </div>
      `;
    }

    return `
      <div class="empty-state">
        <p class="empty-state__title">Sin historial</p>
        <p class="empty-state__text">
          ${escapeHtml(
            config?.text?.emptyBitacoras ||
              "Este estudiante aun no tiene bitacoras registradas."
          )}
        </p>
      </div>
    `;
  }

  const sortedItems = sortBitacorasByDate(items);
  const filteredItems = filterBitacorasBySearch(sortedItems, searchQuery);

  if (searchQuery && !filteredItems.length) {
    return `
      <div class="empty-state">
        <p class="empty-state__title">Sin resultados</p>
        <p class="empty-state__text">
          No encontre bitacoras que coincidan con "${escapeHtml(searchQuery)}".
        </p>
      </div>
    `;
  }

  return `
    <div class="bitacoras-list">
      ${filteredItems
        .map((item) => {
          const originalIndex = sortedItems.findIndex(
            (candidate) => toStringSafe(candidate.id) === toStringSafe(item.id)
          );
          return renderBitacoraCard(
            item,
            originalIndex >= 0 ? originalIndex : 0,
            sortedItems.length
          );
        })
        .join("")}
    </div>
  `;
}

function filterBitacorasBySearch(items = [], query = "") {
  const needle = normalizeText(query);
  if (!needle) return items;

  return items.filter((item) => normalizeText(buildBitacoraSearchText(item)).includes(needle));
}

function buildBitacoraSearchText(item = {}) {
  const structured = parseStructuredContent(item.contenido || item.content || "");
  const overrides = normalizeStudentOverrides(item.studentOverrides, item.studentIds || []);

  return [
    item.titulo,
    item.title,
    item.fechaClase,
    formatDisplayDate(item.fechaClase || item.createdAt),
    item.docente,
    item.author?.name,
    item.author?.displayName,
    item.author?.email,
    item.process?.processLabel,
    item.process?.area,
    item.process?.programa,
    item.process?.docente,
    item.processKey,
    item.contenido,
    item.content,
    structured.docente,
    structured.tareas,
    ...(item.etiquetas || []),
    ...(item.tags || []),
    ...(structured.componenteCorporal || []),
    ...(structured.componenteTecnico || []),
    ...(structured.componenteTeorico || []),
    ...(structured.componenteObras || []),
    ...(item.studentRefs || []).flatMap((student) => [student.name, student.id]),
    ...Object.values(overrides).flatMap((override) => [
      override.processKey,
      override.tareas,
      ...(override.etiquetas || []),
      ...(override.componenteCorporal || []),
      ...(override.componenteTecnico || []),
      ...(override.componenteTeorico || []),
      ...(override.componenteObras || []),
    ]),
  ]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter(Boolean)
    .join(" ");
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
  const chronologicalNumber = Math.max(total - index, 1);
  const sequence = formatBitacoraSequence(chronologicalNumber);

  return `
    <article class="bitacora-card">
      <header class="bitacora-card__header">
        <div>
          <h3 class="bitacora-card__title">
            ${escapeHtml(item.titulo || "Sin titulo")}
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
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            data-bitacora-edit="${escapeHtml(item.id || "")}"
          >
            Editar
          </button>
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            data-bitacora-delete="${escapeHtml(item.id || "")}"
          >
            Eliminar
          </button>
          <span class="badge badge--soft">Clase ${escapeHtml(sequence)}</span>
          <span class="badge">${escapeHtml(mode === CONFIG.modes.group ? "Grupal" : "Individual")}</span>
          <span class="badge">${escapeHtml(studentsLabel)}</span>
          ${
            total > 1
              ? `<span class="badge badge--soft">${escapeHtml(`${chronologicalNumber} de ${total}`)}</span>`
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
              <p class="bitacora-card__files-title">Personalizacion por estudiante</p>
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
                        ${escapeHtml(renderGroupStudentBadgeLabel(item, student))}
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
              <ul class="bitacora-card__files-list bitacora-card__files-list--media">
                ${item.archivos
                  .map(
                    (file) => `
                      <li class="bitacora-card__file-item">
                        ${renderFileThumbnail(file, "bitacora-card__file-thumb")}
                        <div class="bitacora-card__file-copy">
                          <p class="bitacora-card__file-name">${escapeHtml(
                            file.name || file.nombre || "Archivo adjunto"
                          )}</p>
                          ${
                            file.url
                              ? `<a class="bitacora-card__file-link" href="${escapeHtml(file.url)}" target="_blank" rel="noopener noreferrer">Abrir archivo</a>`
                              : ""
                          }
                        </div>
                      </li>
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
    selectedContainer.innerHTML = renderSelectedStudentsChips(selected, {
      allowRemoveAll: isGroupPlaceholderStudent(student),
      draft,
      allStudents,
    });
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

function renderStudentOverridesBlock(student, { force = false } = {}) {
  const container = viewRoot?.querySelector("#student-overrides-block");
  if (!container) return;
  if (!force && isStudentOverrideEditorActive(container)) return;

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

function isStudentOverrideEditorActive(container) {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  return Boolean(
    active &&
      container?.contains(active) &&
      active.matches?.("[data-override-textarea], [data-override-input]")
  );
}

function toggleStudentOverride(primaryStudent, studentId, enabled) {
  const safeStudentId = toStringSafe(studentId);
  if (!safeStudentId) return;

  if (draftInputDebounceTimer) {
    clearTimeout(draftInputDebounceTimer);
    draftInputDebounceTimer = null;
  }

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

  renderStudentOverridesBlock(primaryStudent, { force: true });
  renderDraftMetaBlock(primaryStudent);
}

function getOverrideFieldOptions(inputKey, input) {
  const rawOptions = input?.dataset?.overrideOptions || "";
  if (rawOptions) {
    try {
      const parsed = JSON.parse(rawOptions);
      if (Array.isArray(parsed)) return parsed.map(toStringSafe).filter(Boolean);
    } catch (error) {
      console.warn("No se pudieron leer opciones del ajuste:", inputKey, error);
    }
  }
  return getDatalistOptions(input?.getAttribute("list"));
}

function toggleOverridePickerPanel(inputKey, forceOpen = null) {
  const panel = viewRoot?.querySelector(`[data-override-picker-panel="${CSS.escape(inputKey)}"]`);
  if (!panel) return;
  const shouldOpen =
    forceOpen === null ? !panel.classList.contains("is-open") : Boolean(forceOpen);
  panel.classList.toggle("is-open", shouldOpen);
}

function renderOverridePickerOptionsForInput(inputKey, input) {
  const optionsContainer = viewRoot?.querySelector(
    `[data-override-picker-options="${CSS.escape(inputKey)}"]`
  );
  if (!optionsContainer || !input) return;

  const query = normalizeText(input.value);
  const options = getOverrideFieldOptions(inputKey, input);
  const filtered = options.filter(
    (option) => !query || normalizeText(option).includes(query)
  );

  optionsContainer.innerHTML = renderOverridePickerOptions(
    inputKey,
    filtered,
    getOverrideMultiValueSelection(...String(inputKey).split(":"))
  );
  toggleOverridePickerPanel(inputKey, true);
}

function filterOverrideChips(inputKey, query) {
  const needle = normalizeText(query);
  viewRoot
    ?.querySelectorAll(`[data-override-values="${CSS.escape(inputKey)}"] [data-override-item]`)
    .forEach((chip) => {
      const value = normalizeText(chip.getAttribute("data-override-item"));
      chip.classList.toggle("is-hidden", Boolean(needle) && !value.includes(needle));
    });
}

function startEditOverrideChip(descriptor, student) {
  const studentId = toStringSafe(descriptor?.studentId);
  const key = toStringSafe(descriptor?.key);
  const value = toStringSafe(descriptor?.value);
  if (!studentId || !key || !value) return;

  // Quitar el chip (re-renderiza el bloque) y cargar el valor en el input fresco.
  removeStudentOverrideValue({ studentId, key, value }, student);
  const inputKey = `${studentId}:${key}`;
  const input = viewRoot?.querySelector(`[data-override-input="${CSS.escape(inputKey)}"]`);
  if (!input) return;
  input.value = value;
  input.focus();
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
  renderStudentOverridesBlock(student, { force: true });
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

  renderStudentOverridesBlock(student, { force: true });
  renderDraftMetaBlock(student);
}

function updateGroupStudentProcess(student, studentId, processKey) {
  const safeStudentId = toStringSafe(studentId);
  if (!safeStudentId) return;

  const currentDraft = getDraftForContext(student);
  const currentOverride = getStudentOverrideForDraft(currentDraft, safeStudentId);
  const safeProcessKey = toStringSafe(processKey);
  const nextOverrides = {
    ...normalizeStudentOverrides(currentDraft.studentOverrides, currentDraft.studentIds),
  };

  nextOverrides[safeStudentId] = {
    ...currentOverride,
    processKey: safeProcessKey,
  };

  updateDraft({
    ...currentDraft,
    studentOverrides: nextOverrides,
  });
}

function buildGroupStudentOverridesForPayload(draft = {}, studentIds = [], allStudents = []) {
  const normalizedIds = normalizeStudentIds(studentIds);
  const overrides = normalizeStudentOverrides(draft.studentOverrides, normalizedIds);
  const next = { ...overrides };

  normalizedIds.forEach((studentId) => {
    const student = findStudentById(allStudents, studentId);
    const processes = normalizeStudentProcesses(student || {});
    const existing = getStudentOverrideForDraft({ studentOverrides: next }, studentId);
    const process =
      resolveStudentProcess(student || {}, existing.processKey || draft.processKey) ||
      processes[0] ||
      null;
    const processKey = toStringSafe(existing.processKey || process?.processKey);
    if (!processKey) return;

    next[studentId] = {
      ...existing,
      processKey,
    };
  });

  return normalizeStudentOverrides(next, normalizedIds);
}

function renderSelectedStudentsChips(
  selectedStudents = [],
  { allowRemoveAll = false, draft = {}, allStudents = [] } = {}
) {
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
          (student, index) =>
            renderSelectedStudentChip(student, index, {
              allowRemoveAll,
              draft,
              allStudents,
            })
        )
        .join("")}
    </div>
  `;
}

function renderSelectedStudentChip(
  student,
  index,
  { allowRemoveAll = false, draft = {}, allStudents = [] } = {}
) {
  const studentId = toStringSafe(student?.id);
  const fullStudent = findStudentById(allStudents, studentId) || student;
  const processes = normalizeStudentProcesses(fullStudent);
  const override = getStudentOverrideForDraft(draft, studentId);
  const selectedProcessKey =
    toStringSafe(override.processKey) ||
    toStringSafe(draft?.processKey) ||
    processes[0]?.processKey ||
    "";

  return `
    <article class="selected-student-chip">
      <div class="selected-student-chip__body">
        <p class="selected-student-chip__name">${escapeHtml(student?.name || "Estudiante")}</p>
        <p class="selected-student-chip__meta">${escapeHtml(student?.document || studentId || "")}</p>
        <label class="selected-student-chip__process">
          <span>Proceso de esta bitácora</span>
          <select
            class="field__input field__input--compact"
            data-group-student-process="${escapeHtml(studentId)}"
          >
            ${processes
              .map((process) => {
                const processKey = toStringSafe(process.processKey);
                return `
                  <option value="${escapeHtml(processKey)}" ${
                    processKey === selectedProcessKey ? "selected" : ""
                  }>
                    ${escapeHtml(process.label || process.detalle || process.arte || "Proceso")}
                  </option>
                `;
              })
              .join("")}
          </select>
        </label>
      </div>
      ${
        index === 0 && !allowRemoveAll
          ? `<span class="badge badge--soft">Principal</span>`
          : `
            <button
              type="button"
              class="btn btn--ghost btn--xs"
              data-group-remove-student="${escapeHtml(studentId)}"
            >
              Quitar
            </button>
          `
      }
    </article>
  `;
}

function renderGroupStudentBadgeLabel(item = {}, studentRef = {}) {
  const studentId = toStringSafe(studentRef?.id);
  const override = normalizeStudentOverrides(item.studentOverrides, item.studentIds || [])[studentId];
  const processLabel = override?.processKey
    ? getProcessLabelForStudentOverride(item, studentId, override.processKey)
    : "";
  return [studentRef?.name || studentId || "Estudiante", processLabel]
    .filter(Boolean)
    .join(" · ");
}

function getProcessLabelForStudentOverride(item = {}, studentId = "", processKey = "") {
  const safeProcessKey = toStringSafe(processKey);
  if (!safeProcessKey) return "";

  const allStudents = getAllStudentsFromState(getState());
  const student = findStudentById(allStudents, studentId);
  const process = student ? resolveStudentProcess(student, safeProcessKey) : null;
  return (
    toStringSafe(process?.label || process?.detalle || process?.arte) ||
    toStringSafe(item?.process?.processLabel) ||
    safeProcessKey
  );
}

function findStudentById(students = [], studentId = "") {
  const safeStudentId = toStringSafe(studentId);
  if (!safeStudentId) return null;
  return students.find((student) => getStudentIdentity(student) === safeStudentId) || null;
}

function renderGroupStudentsResults(
  allStudents = [],
  selectedStudents = [],
  searchTerm = ""
) {
  const selectedIds = new Set(selectedStudents.map((item) => item.id));
  const queryText = normalizeText(searchTerm);

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
      ];

      return matchesFlexibleSearch(haystack, queryText);
    })
    .slice(0, 8);

  if (!results.length) {
    return `
      <div class="empty-state empty-state--files">
        <p class="empty-state__text">No hay mas estudiantes para agregar.</p>
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
                      .join("  -  ")
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
  syncModeInputs();
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
  syncModeInputs();
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
    console.warn("No se pudieron cargar los catalogos desde Firestore:", error);
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

  if (primary?.id && !isGroupPlaceholderId(primary.id)) {
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
    academicRecordId: getStudentAcademicRecordId(student),
    linkedStudentIds: getStudentLinkedIds(student),
  };
}

function mapSelectionFromRef(ref) {
  return {
    id: toStringSafe(ref.id),
    name: toStringSafe(ref.name) || toStringSafe(ref.id),
    document: "",
  };
}

/**
 * Decide si una bitacora corresponde al proceso activo seleccionado.
 * A diferencia de la version anterior, las bitacoras grupales NO se saltan
 * el filtro: tambien deben coincidir con el proceso activo (por processKey o,
 * en bitacoras antiguas sin processKey, por datos del proceso normalizados).
 */
function bitacoraMatchesActiveProcess(item, selectedProcess) {
  const safeProcessKey = toStringSafe(currentEditorProcessKey);
  const selectedDetail = normalizeText(
    selectedProcess?.detalle || selectedProcess?.label || ""
  );

  // Sin proceso activo claro: no se filtra (se muestra todo el historial).
  if (!safeProcessKey && !selectedDetail) return true;

  const itemProcessKey = toStringSafe(
    item?.process?.processKey || item?.processKey
  );

  // Si hay processKey en ambos lados, la comparacion es estricta.
  if (safeProcessKey && itemProcessKey) {
    return itemProcessKey === safeProcessKey;
  }

  // Bitacora antigua sin processKey: comparar por datos del proceso.
  if (!selectedDetail) {
    // Hay proceso activo con key, pero el item no tiene key ni con que comparar.
    return false;
  }

  const itemDetails = [
    item?.process?.processLabel,
    item?.process?.label,
    item?.process?.programa,
    item?.process?.detalle,
    item?.process?.area,
  ]
    .flatMap((value) => String(value || "").split(/,|;|\n/g))
    .map((value) => normalizeText(value))
    .filter(Boolean);

  return itemDetails.includes(selectedDetail);
}

/**
 * Obtiene las bitacoras del estudiante SIN aplicar el filtro de proceso activo.
 * Se usa para saber cuantas bitacoras totales tiene el estudiante y poder
 * mostrar mensajes vacios mas claros.
 */
function getRawBitacorasFromState(studentOrRef) {
  const studentRef = isPlainObject(studentOrRef)
    ? getStudentIdentity(studentOrRef)
    : toStringSafe(studentOrRef);
  const fallbackId = isPlainObject(studentOrRef)
    ? getStudentFallbackId(studentOrRef)
    : "";

  const selectedItems = getSelectedStudentBitacoras();
  if (Array.isArray(selectedItems) && selectedItems.length) {
    return sortBitacorasByDate(selectedItems.map(normalizeBitacora).filter(Boolean));
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
      return sortBitacorasByDate(candidate.map(normalizeBitacora).filter(Boolean));
    }
  }

  return [];
}

function getBitacorasFromState(studentOrRef) {
  const selectedProcess =
    studentOrRef && typeof studentOrRef === "object"
      ? resolveStudentProcess(studentOrRef, currentEditorProcessKey)
      : null;

  const rawItems = getRawBitacorasFromState(studentOrRef);
  return rawItems.filter((item) =>
    bitacoraMatchesActiveProcess(item, selectedProcess)
  );
}

function isGroupBitacoraForStudent(item = {}, studentRef = "", fallbackId = "") {
  const studentIds = normalizeStudentIds(item.studentIds || [item.studentId]);
  const studentRefs = normalizeStudentRefs(item.studentRefs || []);
  const safeStudentRef = toStringSafe(studentRef);
  const safeFallbackId = toStringSafe(fallbackId);
  const belongsToStudent =
    (safeStudentRef && studentIds.includes(safeStudentRef)) ||
    (safeFallbackId && studentIds.includes(safeFallbackId));
  const isGroup =
    item.mode === CONFIG.modes.group ||
    studentIds.length > 1 ||
    studentRefs.length > 1;

  return Boolean(isGroup && belongsToStudent);
}

function getStudentFromState(state, preferredStudentRef = null) {
  // Bitacora grupal en blanco: si el contexto apunta al placeholder, devuelve un
  // estudiante sintetico para que el editor pueda renderizarse sin un estudiante
  // principal real. Los integrantes se agregan desde el buscador interno.
  if (
    isGroupPlaceholderId(preferredStudentRef) ||
    (!preferredStudentRef && isGroupPlaceholderStudent(state?.students?.selected))
  ) {
    return createGroupPlaceholderStudent();
  }

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
          Primero seleccionen un estudiante desde busqueda. El sistema no puede
          adivinar a quien le estan escribiendo la bitacora, por mas ganas que tenga.
        </p>
        <div class="empty-state-card__actions">
          <button
            type="button"
            class="btn btn--primary"
            id="editor-missing-back-btn"
          >
            Ir a busqueda
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
 * Se deja local a proposito:
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
      kind: file.kind || "support",
      uploadedAt: file.uploadedAt || null,
      previewUrl: file.previewUrl || "",
      sourceFile: file.sourceFile instanceof File ? file.sourceFile : null,
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
    sourceFile: file,
    previewUrl: typeof URL !== "undefined" ? URL.createObjectURL(file) : "",
  };
}

function getRenderableFileUrl(file = {}) {
  if (file?.url) return String(file.url);
  if (file?.previewUrl) return String(file.previewUrl);
  if (file?.sourceFile instanceof File && typeof URL !== "undefined") {
    return URL.createObjectURL(file.sourceFile);
  }
  return "";
}

function getFileMimeType(file = {}) {
  return String(file?.type || "").toLowerCase();
}

function isImageAttachment(file = {}) {
  const mime = getFileMimeType(file);
  if (mime.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(String(file?.name || file?.url || ""));
}

function isVideoAttachment(file = {}) {
  const mime = getFileMimeType(file);
  if (mime.startsWith("video/")) return true;
  return /\.(mp4|webm|ogg|mov|m4v)$/i.test(String(file?.name || file?.url || ""));
}

function renderFileThumbnail(file = {}, className = "") {
  const url = getRenderableFileUrl(file);
  if (!url) {
    return `<div class="${escapeHtml(className)} is-empty" aria-hidden="true">ðŸ“Ž</div>`;
  }

  if (isImageAttachment(file)) {
    return `<img class="${escapeHtml(className)}" src="${escapeHtml(url)}" alt="${escapeHtml(file?.name || "Imagen adjunta")}" loading="lazy" />`;
  }

  if (isVideoAttachment(file)) {
    return `<video class="${escapeHtml(className)}" src="${escapeHtml(url)}" muted playsinline preload="metadata" aria-label="${escapeHtml(file?.name || "Video adjunto")}"></video>`;
  }

  return `<div class="${escapeHtml(className)} is-empty" aria-hidden="true">ðŸ“Ž</div>`;
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
    processKey: currentEditorProcessKey || "",
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

function getRequestedProcessFromPayload(payload) {
  return toStringSafe(payload?.processKey || payload?.processRef || payload?.process);
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
  const isBlankGroup = isGroupPlaceholderStudent(student);
  const isGroup = isBlankGroup || draft.mode === CONFIG.modes.group;
  const draftFields = getStructuredDraftFields(draft, student);
  const catalogs = cachedCatalogs || getEmptyCatalogs();
  const teacherOptions = getTeacherOptions(
    catalogs.docentes,
    allStudents,
    student,
    getDraftTeachers(draft, draftFields, student).join(", ")
  );
  const selectedStudents = getSelectedStudentsForDraft(draft, student, allStudents);
  const processOptions = normalizeStudentProcesses(student);
  const activeProcess =
    resolveStudentProcess(student, currentEditorProcessKey || draft.processKey) ||
    processOptions[0] ||
    null;
  const areaCatalogs = getCatalogsForProcess(catalogs, activeProcess, student);
  const categoriasOptions = getCatalogOptions(areaCatalogs.categorias);
  const corporalOptions = getCatalogOptions(areaCatalogs.componenteCorporal);
  const tecnicoOptions = getCatalogOptions(areaCatalogs.componenteTecnico);
  const teoricoOptions = getCatalogOptions(areaCatalogs.componenteTeorico);
  const obrasOptions = getCatalogOptions(areaCatalogs.componenteObras);
  const activeProcessLabel = toStringSafe(
    activeProcess?.label || activeProcess?.detalle || activeProcess?.arte || "Proceso"
  );

  return `
    <section class="view-shell view-shell--editor">
      <header class="view-header view-header--actions-only">
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
                ${
                  isBlankGroup
                    ? ""
                    : `
                <label class="choice-pill">
                  <input
                    type="radio"
                    name="modoBitacora"
                    value="${escapeHtml(CONFIG.modes.individual)}"
                    ${!isGroup ? "checked" : ""}
                  />
                  <span>Individual</span>
                </label>
                `
                }
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
                  <span class="field__label">Proceso activo</span>
                  <select id="bitacora-process-select" class="field__input">
                    ${processOptions
                      .map(
                        (process) => `
                          <option value="${escapeHtml(process.processKey)}" ${
                            process.processKey === activeProcess?.processKey
                              ? "selected"
                              : ""
                          }>
                            ${escapeHtml(process.label || process.detalle || process.arte || "Proceso")}
                          </option>
                        `
                      )
                      .join("")}
                  </select>
                </label>
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

                ${renderMultiValueField({
                  key: "docentes",
                  label: "Docentes",
                  inputId: "bitacora-docentes-input",
                  listId: "bitacora-docentes-list",
                  placeholder: "Escribe o elige docentes para esta clase...",
                  hint: "Puedes agregar mas de un docente para clases compartidas.",
                  options: teacherOptions,
                  selectedValues: getDraftTeachers(draft, draftFields, student),
                })}
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
                      getSelectedStudentsForDraft(draft, student, allStudents),
                      {
                        allowRemoveAll: isGroupPlaceholderStudent(student),
                        draft,
                        allStudents,
                      }
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
                  getStudentOverrideCatalogOptions(areaCatalogs)
                )}
              </section>

              <div class="editor-form-grid editor-form-grid--2">
                ${renderMultiValueField({
                  key: "etiquetas",
                  label: "Categorias",
                  inputId: "bitacora-etiquetas-input",
                  listId: "bitacora-categorias-list",
                  placeholder: "Escribe o elige una categoria y agregala...",
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
                    capture="environment"
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
                    capture="environment"
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
                    ${!isAuthenticated ? 'data-disabled-by-access="true"' : ""}
                    aria-busy="false"
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
                <h2 class="panel-header__title" id="bitacoras-history-title">Bitacoras registradas (${escapeHtml(activeProcessLabel)})</h2>
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
            ${renderHistorySearchControl(currentHistorySearchQuery)}
            <div id="bitacoras-history">
              ${renderBitacorasHistory(bitacoras, isLoading, config, isAuthenticated, currentHistorySearchQuery, { hasActiveProcess: Boolean(toStringSafe(currentEditorProcessKey)), totalForStudent: getRawBitacorasFromState(student).length })}
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
  const displayTasks = containsStructuredMarkers(tasks) ? "" : tasks;
  const sections = [
    renderBitacoraValueSection("Tareas / observaciones", displayTasks),
    renderBitacoraListSection("Componente corporal", content.componenteCorporal),
    renderBitacoraListSection("Componente tecnico", content.componenteTecnico),
    renderBitacoraListSection("Componente teorico", content.componenteTeorico),
    renderBitacoraListSection("Componente de obras", content.componenteObras),
    renderBitacoraListSection("Docentes", normalizeListValues(content.docentes || content.docente)),
  ].filter(Boolean);

  if (!sections.length) {
    return `<p class="bitacora-card__summary-line">Sin contenido registrado.</p>`;
  }

  return `
    <div class="bitacora-card__sections-grid">
      ${sections.join("")}
    </div>
  `;
}

function renderBitacoraValueSection(label, value) {
  const text = toStringSafe(value);
  if (!text) return "";

  return `
    <section class="bitacora-card__section bitacora-card__section--wide">
      <p class="bitacora-card__section-label">${escapeHtml(label)}</p>
      <p class="bitacora-card__section-text">${escapeHtml(text)}</p>
    </section>
  `;
}

function renderBitacoraListSection(label, values = []) {
  const items = normalizeListValues(values);
  if (!items.length) return "";

  return `
    <section class="bitacora-card__section">
      <p class="bitacora-card__section-label">${escapeHtml(label)}</p>
      <div class="bitacora-card__section-tags">
        ${items.map((item) => `<span class="badge badge--soft">${escapeHtml(item)}</span>`).join("")}
      </div>
    </section>
  `;
}

function getBitacoraAuthorName(item = {}, structuredContent = {}) {
  const docentes = normalizeListValues(item?.docentes || item?.docente || structuredContent?.docente);
  if (docentes.length) return docentes.join(", ");

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

/**
 * Devuelve la clase de color del punto segun el estado del estudiante:
 * verde (activo), ambar (en pausa) o gris (inactivo / desconocido).
 */
function resolveStudentStatusTone(estado = "") {
  const normalized = normalizeText(estado);
  if (!normalized) return "neutral";
  if (normalized.includes("pausa")) return "warning";
  if (normalized.includes("inactivo")) return "muted";
  if (normalized.includes("activo")) return "active";
  return "neutral";
}

function renderStudentStatusDot(student) {
  const estado = getReadableValue(student?.estado, "Sin estado");
  const tone = resolveStudentStatusTone(student?.estado);
  return `<span class="student-summary__status student-summary__status--${tone}" title="${escapeHtml(
    estado
  )}"><span class="student-summary__status-dot" aria-hidden="true"></span><span class="sr-only">${escapeHtml(
    estado
  )}</span></span>`;
}

function renderStudentSummaryCompact(student) {
  if (!student) {
    return `<div class="empty-state empty-state--files"><p class="empty-state__text">No hay estudiante seleccionado.</p></div>`;
  }

  if (isGroupPlaceholderStudent(student)) {
    return `
      <article class="student-summary student-summary--compact">
        <div class="student-summary__identity">
          <p class="student-summary__eyebrow">Bitacora grupal</p>
          <h2 class="student-summary__name">Nuevo grupo</h2>
          <p class="student-summary__doc">Busca y agrega los estudiantes mas abajo.</p>
        </div>
      </article>
    `;
  }

  return `
    <article class="student-summary student-summary--compact">
      <div class="student-summary__identity">
        ${renderStudentStatusDot(student)}
        <h2 class="student-summary__name">${escapeHtml(getStudentName(student))}</h2>
      </div>
      <div class="student-summary__aside">
        <div class="student-summary__badges">
          <span class="badge">${escapeHtml(
            getReadableValue(getStudentProcessesSummary(student), "Sin procesos")
          )}</span>
        </div>
        <dl class="student-summary__facts">
          <div class="student-summary__fact">
            <dt>Área</dt>
            <dd>${escapeHtml(
              getReadableValue(
                firstNonEmpty(student.area, student.instrumento, student.programa),
                "Sin área"
              )
            )}</dd>
          </div>
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
          <div class="student-summary__fact">
            <dt>Condición</dt>
            <dd>${escapeHtml(getReadableValue(getStudentCondition(student), "Sin condición registrada"))}</dd>
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
  return uniqueByNormalized((Array.isArray(values) ? values : []).map((item) => toStringSafe(item)).filter(Boolean));
}

function uniqueByNormalized(values = []) {
  const seen = new Set();
  const result = [];

  values.forEach((value) => {
    const label = toStringSafe(value);
    const key = normalizeText(label);
    if (!label || seen.has(key)) return;
    seen.add(key);
    result.push(label);
  });

  return result;
}

// Las opciones mas usadas se guardan por docente: namespacing la clave de
// localStorage con el uid/email del usuario autenticado, para que en equipos
// compartidos cada docente vea arriba sus propios items frecuentes.
function getRecentPickersStorageKey() {
  const user = getState()?.auth?.user || null;
  const owner = toStringSafe(user?.uid || user?.email).toLowerCase();
  return owner ? `${RECENT_PICKERS_KEY}__${owner}` : RECENT_PICKERS_KEY;
}

function getRecentPickers() {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(getRecentPickersStorageKey()) || "{}"
    );
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Normaliza el almacenamiento de un componente a un mapa
// { valorNormalizado: { label, count, ts } }. Acepta el formato viejo (arreglo
// de strings, donde el orden representaba recencia) para no perder lo guardado.
function normalizeRecentEntry(rawForKey) {
  const map = {};

  if (Array.isArray(rawForKey)) {
    rawForKey.forEach((label, index) => {
      const norm = normalizeText(label);
      if (!norm || map[norm]) return;
      // El primero del arreglo era el mas reciente: le damos mayor conteo para
      // conservar ese orden hasta que el uso real lo ajuste.
      map[norm] = { label: toStringSafe(label), count: rawForKey.length - index, ts: 0 };
    });
    return map;
  }

  if (rawForKey && typeof rawForKey === "object") {
    Object.entries(rawForKey).forEach(([norm, entry]) => {
      if (!norm || !entry || typeof entry !== "object") return;
      map[norm] = {
        label: toStringSafe(entry.label) || norm,
        count: Number(entry.count) || 1,
        ts: Number(entry.ts) || 0,
      };
    });
  }

  return map;
}

// Devuelve los valores ordenados por frecuencia (mas usados primero) y, a igual
// frecuencia, por uso mas reciente.
function getRankedPickerValues(key) {
  const recent = getRecentPickers();
  const map = normalizeRecentEntry(recent[key]);
  return Object.values(map)
    .sort((a, b) => b.count - a.count || b.ts - a.ts)
    .map((entry) => entry.label);
}

function rememberPickerValues(key, values = []) {
  const cleanValues = normalizeListValues(values);
  if (!key || !cleanValues.length) return;

  try {
    const recent = getRecentPickers();
    const map = normalizeRecentEntry(recent[key]);
    const now = Date.now();

    cleanValues.forEach((label) => {
      const norm = normalizeText(label);
      if (!norm) return;
      const prev = map[norm];
      map[norm] = {
        label: toStringSafe(label),
        count: (prev?.count || 0) + 1,
        ts: now,
      };
    });

    // Conserva solo los mas usados para acotar el almacenamiento.
    recent[key] = Object.values(map)
      .sort((a, b) => b.count - a.count || b.ts - a.ts)
      .slice(0, RECENT_PICKERS_LIMIT)
      .reduce((acc, entry) => {
        acc[normalizeText(entry.label)] = entry;
        return acc;
      }, {});

    localStorage.setItem(getRecentPickersStorageKey(), JSON.stringify(recent));
  } catch (error) {
    console.warn("No se pudieron guardar opciones frecuentes:", error);
  }
}

function prioritizePickerOptions(key, options = []) {
  // Solo subimos arriba los mas usados que aun existan en el catalogo actual,
  // para no mostrar items eliminados o de otra area.
  const optionSet = new Set(options.map((option) => normalizeText(option)));
  const ranked = getRankedPickerValues(key).filter((value) =>
    optionSet.has(normalizeText(value))
  );

  return uniqueByNormalized([...ranked, ...options]);
}

function getDraftTeachers(draft = {}, structured = {}, student = {}) {
  return normalizeListValues([
    ...(Array.isArray(draft.docentes) ? draft.docentes : []),
    draft.docente,
    structured.docente,
  ]);
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
    const prioritizedOptions = prioritizePickerOptions(key, options);
    const visibleOptions = prioritizedOptions.slice(0, 80);
    const isDirectEntry = key === "docentes";
    const usesNativeDatalist = isDirectEntry;
    return `
      <section class="field field--multi-value">
        <span class="field__label">${escapeHtml(label)}</span>
        <div class="multi-value-entry">
        <input
          id="${escapeHtml(inputId)}"
          type="text"
          class="field__input"
            data-multi-input="${escapeHtml(key)}"
            data-multi-options="${escapeHtml(JSON.stringify(prioritizedOptions))}"
            ${usesNativeDatalist ? `list="${escapeHtml(listId)}"` : ""}
            placeholder="${escapeHtml(placeholder)}"
            autocomplete="off"
          />
          ${
            isDirectEntry
              ? `<button type="button" class="btn btn--secondary btn--sm" data-multi-add="${escapeHtml(key)}">Agregar</button>`
              : `<button type="button" class="btn btn--ghost btn--sm" data-picker-toggle="${escapeHtml(key)}">Opciones</button>`
          }
        </div>
        <small class="field__hint">${escapeHtml(hint)}</small>
        ${
          isDirectEntry
            ? ""
            : `
              <div class="multi-picker-panel" data-picker-panel="${escapeHtml(key)}">
                <div class="multi-picker-panel__actions">
                  <button type="button" class="btn btn--primary btn--sm" data-picker-add-pending="${escapeHtml(key)}" disabled>
                    Agregar seleccionadas
                  </button>
                </div>
                <div class="multi-picker-options multi-picker-options--buttons" data-picker-options="${escapeHtml(key)}">
                  ${renderMultiPickerOptions(key, visibleOptions, selectedValues)}
                </div>
              </div>
            `
        }
        <div class="multi-value-search ${selectedValues.length > MULTI_CHIP_SEARCH_THRESHOLD ? "" : "is-hidden"}" data-chip-search-wrap="${escapeHtml(key)}">
          <input
            type="text"
            class="field__input field__input--sm"
            data-chip-search="${escapeHtml(key)}"
            placeholder="Filtrar agregados..."
            autocomplete="off"
          />
        </div>
        <div class="multi-value-list" data-multi-values="${escapeHtml(key)}">
          ${renderMultiValueChips(key, selectedValues)}
      </div>
      ${usesNativeDatalist ? renderDatalist(listId, prioritizedOptions) : ""}
    </section>
  `;
}

function renderMultiPickerOptions(key, options = [], selectedValues = [], pendingValues = []) {
  const selected = new Set(normalizeListValues(selectedValues).map((value) => normalizeText(value)));
  const pending = new Set(normalizeListValues(pendingValues).map((value) => normalizeText(value)));
  const items = normalizeListValues(options);

  if (!items.length) {
    return `<p class="multi-picker-empty">No hay opciones en el catalogo. Puedes escribir un valor y agregarlo con Enter.</p>`;
  }

  // Con catalogos muy grandes (cientos/miles de items) pintar todos los botones
  // de golpe congela la vista. Limitamos cuantos se renderizan y dejamos que el
  // buscador del campo acote el resto.
  const visibleItems = items.slice(0, PICKER_RENDER_LIMIT);
  const hiddenCount = items.length - visibleItems.length;

  const optionsMarkup = visibleItems
    .map((option) => {
      const isSelected = selected.has(normalizeText(option));
      const isPending = pending.has(normalizeText(option));
      return `
        <button
          type="button"
          class="multi-picker-option ${isSelected ? "is-selected" : ""} ${isPending ? "is-pending" : ""}"
          data-picker-pending="${escapeHtml(key)}"
          data-picker-option="${escapeHtml(key)}"
          data-picker-toggle-option="${escapeHtml(key)}"
          data-picker-value="${escapeHtml(option)}"
          aria-pressed="${isPending ? "true" : "false"}"
          title="${escapeHtml(option)}"
          ${isSelected ? "disabled" : ""}
        >
          <span>${escapeHtml(option)}</span>
          <small data-picker-action-label>${isSelected ? "Agregada" : isPending ? "Seleccionada" : "Elegir"}</small>
        </button>
      `;
    })
    .join("");

  if (hiddenCount <= 0) return optionsMarkup;

  return `
    ${optionsMarkup}
    <p class="multi-picker-empty">
      Mostrando ${visibleItems.length} de ${items.length} opciones. Escribe en el campo de arriba para filtrar y encontrar el resto.
    </p>
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
        <span class="multi-value-chip" data-multi-item="${escapeHtml(value)}" title="${escapeHtml(value)}">
          <span class="multi-value-chip__text">${escapeHtml(value)}</span>
          <button
            type="button"
            class="multi-value-chip__edit"
            data-multi-key="${escapeHtml(key)}"
            data-multi-edit="${escapeHtml(value)}"
            aria-label="Editar ${escapeHtml(value)}"
            title="Editar"
          >
            Editar
          </button>
          <button
            type="button"
            class="multi-value-chip__remove"
            data-multi-key="${escapeHtml(key)}"
            data-multi-remove="${escapeHtml(value)}"
            aria-label="Quitar ${escapeHtml(value)}"
          >
            x
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
        <p class="empty-state__text">Selecciona estudiantes para personalizar la bitacora por estudiante.</p>
      </div>
    `;
  }

  if (selectedStudents.length < 2) {
    return `
      <div class="empty-state empty-state--files">
        <p class="empty-state__text">Agrega al menos un estudiante mas al grupo para personalizar la bitacora por estudiante.</p>
      </div>
    `;
  }

  return `
    <div class="student-overrides__header">
      <div>
        <p class="panel-header__eyebrow">Personalizaciones</p>
        <h3 class="panel-header__title">Personalizar bitacora por estudiante</h3>
      </div>
      <p class="section-text">
        La bitacora general se aplica a todos. Personalizala solo para quien necesite ejercicios, observaciones o tareas diferentes.
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
      <div class="student-override-card__toggle" data-override-toggle-row="${escapeHtml(studentId)}">
        <div class="student-override-card__identity">
          <p class="student-override-card__name">${escapeHtml(student?.name || "Estudiante")}</p>
          <p class="student-override-card__meta">${escapeHtml(
            student?.document || studentId || "Sin documento"
          )}</p>
        </div>
        <button
          type="button"
          class="student-override-card__switch"
          data-override-enabled="${escapeHtml(studentId)}"
          aria-pressed="${selectedOverride.enabled ? "true" : "false"}"
          aria-label="${selectedOverride.enabled ? "Desactivar personalizacion de este estudiante" : "Activar personalizacion de este estudiante"}"
        >
          <span class="student-override-card__switch-label">Personalizar bitacora</span>
          <span class="student-override-card__switch-track" aria-hidden="true">
            <span class="student-override-card__switch-dot"></span>
          </span>
          <span class="student-override-card__switch-state">${selectedOverride.enabled ? "Activada" : "Desactivada"}</span>
        </button>
      </div>
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
  const selectedValues = normalizeListValues(values);
  const prioritizedOptions = prioritizePickerOptions(key, options);
  const visibleOptions = prioritizedOptions.slice(0, 80);

    return `
      <section class="field field--multi-value field--override">
        <span class="field__label">${escapeHtml(label)}</span>
        <div class="multi-value-entry">
        <input
          type="text"
          class="field__input"
          data-override-input="${escapeHtml(inputKey)}"
          data-override-options="${escapeHtml(JSON.stringify(prioritizedOptions))}"
          placeholder="${escapeHtml(placeholder)}"
          autocomplete="off"
          />
          <button type="button" class="btn btn--ghost btn--sm" data-override-picker-toggle="${escapeHtml(inputKey)}">Opciones</button>
        </div>
        <div class="multi-picker-panel" data-override-picker-panel="${escapeHtml(inputKey)}">
          <div class="multi-picker-options multi-picker-options--buttons" data-override-picker-options="${escapeHtml(inputKey)}">
            ${renderOverridePickerOptions(inputKey, visibleOptions, selectedValues)}
          </div>
        </div>
        <div class="multi-value-search ${selectedValues.length > MULTI_CHIP_SEARCH_THRESHOLD ? "" : "is-hidden"}" data-override-chip-search-wrap="${escapeHtml(inputKey)}">
          <input
            type="text"
            class="field__input field__input--sm"
            data-override-chip-search="${escapeHtml(inputKey)}"
            placeholder="Filtrar agregados..."
            autocomplete="off"
          />
        </div>
        <div class="multi-value-list" data-override-values="${escapeHtml(inputKey)}">
          ${renderStudentOverrideChips(studentId, key, selectedValues)}
        </div>
    </section>
  `;
}

function renderOverridePickerOptions(inputKey, options = [], selectedValues = []) {
  const selected = new Set(
    normalizeListValues(selectedValues).map((value) => normalizeText(value))
  );
  const items = normalizeListValues(options);

  if (!items.length) {
    return `<p class="multi-picker-empty">No hay opciones en el catalogo. Puedes escribir un valor y agregarlo con Enter.</p>`;
  }

  const visibleItems = items.slice(0, PICKER_RENDER_LIMIT);
  const hiddenCount = items.length - visibleItems.length;

  const optionsMarkup = visibleItems
    .map((option) => {
      const isSelected = selected.has(normalizeText(option));
      return `
        <button
          type="button"
          class="multi-picker-option ${isSelected ? "is-selected" : ""}"
          data-override-picker-add="${escapeHtml(inputKey)}"
          data-override-picker-value="${escapeHtml(option)}"
          title="${escapeHtml(option)}"
          ${isSelected ? "disabled" : ""}
        >
          <span>${escapeHtml(option)}</span>
          <small>${isSelected ? "Agregada" : "Elegir"}</small>
        </button>
      `;
    })
    .join("");

  if (hiddenCount <= 0) return optionsMarkup;

  return `
    ${optionsMarkup}
    <p class="multi-picker-empty">
      Mostrando ${visibleItems.length} de ${items.length} opciones. Escribe en el campo de arriba para filtrar y encontrar el resto.
    </p>
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
        <span class="multi-value-chip" data-override-item="${escapeHtml(value)}" title="${escapeHtml(value)}">
          <span class="multi-value-chip__text">${escapeHtml(value)}</span>
          <button
            type="button"
            class="multi-value-chip__edit"
            data-override-edit="true"
            data-override-student="${escapeHtml(studentId)}"
            data-override-key="${escapeHtml(key)}"
            data-override-value="${escapeHtml(value)}"
            aria-label="Editar ${escapeHtml(value)}"
            title="Editar"
          >
            Editar
          </button>
          <button
            type="button"
            class="multi-value-chip__remove"
            data-override-remove="true"
            data-override-student="${escapeHtml(studentId)}"
            data-override-key="${escapeHtml(key)}"
            data-override-value="${escapeHtml(value)}"
            aria-label="Quitar ${escapeHtml(value)}"
          >
            x
          </button>
        </span>
      `
    )
    .join("");
}

function getStudentOverrideCatalogOptions(catalogs = cachedCatalogs || getEmptyCatalogs()) {
  return {
    etiquetas: getCatalogOptions(catalogs.categorias),
    componenteCorporal: getCatalogOptions(catalogs.componenteCorporal),
    componenteTecnico: getCatalogOptions(catalogs.componenteTecnico),
    componenteTeorico: getCatalogOptions(catalogs.componenteTeorico),
    componenteObras: getCatalogOptions(catalogs.componenteObras),
  };
}

function getCatalogsForProcess(catalogs = {}, process = {}, student = {}) {
  const base = {
    categorias: catalogs.categorias || [],
    componenteCorporal: catalogs.componenteCorporal || [],
    componenteTecnico: catalogs.componenteTecnico || [],
    componenteTeorico: catalogs.componenteTeorico || [],
    componenteObras: catalogs.componenteObras || [],
  };
  const areaKeys = getAreaCatalogKeys(process, student);

  return {
    categorias: resolveAreaCatalogList(catalogs, "categorias", areaKeys, base.categorias),
    componenteCorporal: resolveAreaCatalogList(catalogs, "componenteCorporal", areaKeys, base.componenteCorporal),
    componenteTecnico: resolveAreaCatalogList(catalogs, "componenteTecnico", areaKeys, base.componenteTecnico),
    componenteTeorico: resolveAreaCatalogList(catalogs, "componenteTeorico", areaKeys, base.componenteTeorico),
    componenteObras: resolveAreaCatalogList(catalogs, "componenteObras", areaKeys, base.componenteObras),
  };
}

// El catalogo se agrupa por las 4 areas canonicas (musica, danza, artes
// plasticas, teatro), pero los procesos a veces usan nombres alternos: el caso
// tipico es "Baile" en lugar de "Danza". Sin este mapeo, el area no coincide con
// ninguna clave del catalogo y se cae al fallback que mezcla TODAS las areas.
// Cada entrada agrega su(s) equivalente(s) canonico(s) cuando el valor del
// proceso contiene alguno de los terminos indicados.
const AREA_KEY_SYNONYMS = [
  { canonical: "danza", matchers: ["danza", "baile"] },
  { canonical: "teatro", matchers: ["teatro", "actuacion", "dramaturgia"] },
  {
    canonical: "artesplasticas",
    matchers: [
      "plastica",
      "plasticas",
      "dibujo",
      "pintura",
      "ceramica",
      "modelado",
      "manualidades",
    ],
  },
  {
    canonical: "musica",
    matchers: [
      "musica",
      "guitarra",
      "piano",
      "teclado",
      "bateria",
      "percusion",
      "canto",
      "violin",
      "cello",
      "violoncello",
      "bajo",
      "ukulele",
      "saxofon",
      "flauta",
    ],
  },
];

// Resuelve un valor (p.ej. "BAILE", "Guitarra", "Artes plasticas") a su area
// macro canonica. Devuelve "" si no corresponde a ninguna de las 4 areas.
function resolveCanonicalArea(value) {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  const match = AREA_KEY_SYNONYMS.find(({ matchers }) =>
    matchers.some((term) => normalized.includes(term))
  );
  return match ? match.canonical : "";
}

// El catalogo se filtra SOLO por las 4 areas macro (musica, danza, artes
// plasticas, teatro). El enfasis (latino, instrumento, etc.) NO se usa para
// filtrar: todo lo que sea de Musica aplica a cualquier proceso de Musica, lo de
// Danza/Baile a cualquier proceso de danza, y asi sucesivamente.
function getAreaCatalogKeys(process = {}, student = {}) {
  // 1) Primero el area macro declarada explicitamente.
  const macroValues = [process?.arte, process?.area, student?.area];
  // 2) Como respaldo, instrumento/programa/detalle (por si no hay area macro).
  const detailValues = [
    process?.instrumento,
    process?.programa,
    process?.detalle,
    student?.instrumento,
    student?.programa,
  ];

  const fromMacro = new Set();
  macroValues.forEach((value) => {
    const canonical = resolveCanonicalArea(value);
    if (canonical) fromMacro.add(canonical);
  });
  if (fromMacro.size) return [...fromMacro];

  const fromDetail = new Set();
  detailValues.forEach((value) => {
    const canonical = resolveCanonicalArea(value);
    if (canonical) fromDetail.add(canonical);
  });
  if (fromDetail.size) return [...fromDetail];

  // 3) Sin coincidencia con las 4 areas: usar las claves crudas (compatibilidad).
  return uniqueByNormalized([...macroValues, ...detailValues]).map((value) =>
    normalizeText(value)
  );
}

function resolveAreaCatalogList(catalogs = {}, key, areaKeys = [], fallback = []) {
  const groupedByField = catalogs[`${key}PorArte`];
  const nestedByArea = catalogs.porArte || catalogs.catalogosPorArte || {};
  const fromGrouped = findCatalogGroup(groupedByField, areaKeys);

  // Items del catalogo general que no estan asignados a NINGUNA area se tratan
  // como universales: deben aparecer en todas las areas. Esto cubre items
  // nuevos que aun no se han marcado en la matriz por arte y evita que
  // "desaparezcan" del editor cuando el area ya tiene otras asignaciones.
  const orphanGeneralItems = getUnassignedGeneralItems(groupedByField, fallback);

  if (fromGrouped.length) {
    return uniqueByNormalized([...fromGrouped, ...orphanGeneralItems]);
  }

  for (const [areaName, areaCatalog] of Object.entries(nestedByArea || {})) {
    if (!matchesAreaCatalogKey(areaName, areaKeys)) continue;
    if (Array.isArray(areaCatalog)) return areaCatalog;
    if (areaCatalog && typeof areaCatalog === "object") {
      const values = areaCatalog[key];
      if (Array.isArray(values) && values.length) return values;
    }
  }

  const filteredFallback = getCatalogOptions(fallback).filter((value) => {
    const normalizedValue = normalizeText(value);
    return areaKeys.some((areaKey) => areaKey && normalizedValue.includes(areaKey));
  });

  if (filteredFallback.length) return filteredFallback;

  return fallback;
}

function getUnassignedGeneralItems(groupedByField, fallback = []) {
  const general = getCatalogOptions(fallback);
  if (!groupedByField || typeof groupedByField !== "object") return general;

  const assigned = new Set();
  Object.values(groupedByField).forEach((values) => {
    if (Array.isArray(values)) {
      values.forEach((value) => assigned.add(normalizeText(value)));
    }
  });

  return general.filter((item) => !assigned.has(normalizeText(item)));
}

function findCatalogGroup(groups = {}, areaKeys = []) {
  if (!groups || typeof groups !== "object") return [];

  for (const [name, values] of Object.entries(groups)) {
    if (matchesAreaCatalogKey(name, areaKeys) && Array.isArray(values)) {
      return values;
    }
  }

  return [];
}

function matchesAreaCatalogKey(name, areaKeys = []) {
  const normalizedName = normalizeText(name);
  if (!normalizedName) return false;

  return areaKeys.some((areaKey) => {
    if (!areaKey) return false;
    return areaKey === normalizedName ||
      areaKey.includes(normalizedName) ||
      normalizedName.includes(areaKey);
  });
}

function buildAutoTitle(student, fechaClase = "", draft = null) {
  const safeDate = toStringSafe(fechaClase || getTodayDate());

  // En bitacoras grupales el titulo no debe quedar con el nombre del primer
  // estudiante seleccionado (confunde al verla desde otro integrante).
  if (draft && getAllowedMode(draft.mode) === CONFIG.modes.group) {
    const count =
      normalizeStudentRefs(draft.studentRefs || []).length ||
      normalizeStudentIds(draft.studentIds || []).length;
    const suffix = count
      ? ` (${count} ${count === 1 ? "estudiante" : "estudiantes"})`
      : "";
    return `Registro de clase grupal ${safeDate}${suffix}`;
  }

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
  "REPERTORIO ESCOGIDO",
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

  result.tareas = "";

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
  const docentes = normalizeListValues(fields.docentes || fields.docente);
  const normalized = {
    docente: docentes.join(", "),
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
      ? `COMPONENTE CORPORAL:\n${normalized.componenteCorporal.join("\n")}`
      : "",
    normalized.componenteTecnico.length
      ? `COMPONENTE TECNICO:\n${normalized.componenteTecnico.join("\n")}`
      : "",
    normalized.componenteTeorico.length
      ? `COMPONENTE TEORICO:\n${normalized.componenteTeorico.join("\n")}`
      : "",
    normalized.componenteObras.length
      ? `COMPONENTE DE OBRAS:\n${normalized.componenteObras.join("\n")}`
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
    docentes: normalizeListValues(draft?.docentes || draft?.docente || safeDocente),
    tareas: safeTareas || "",
    componenteCorporal: normalizeListValues(parsed.componenteCorporal),
    componenteTecnico: normalizeListValues(parsed.componenteTecnico),
    componenteTeorico: normalizeListValues(parsed.componenteTeorico),
    componenteObras: normalizeListValues(parsed.componenteObras),
  };
}

function normalizeListValues(values = []) {
  const source = Array.isArray(values) ? values : [values];

  // IMPORTANTE: solo separamos por salto de linea. Antes se separaba tambien por
  // coma y punto y coma, lo que rompia items cuyo NOMBRE contiene comas (p. ej.
  // "Sevcik - SOVT Op. 1 pag. 1, sistema 1, compas 01"): se fragmentaban en el
  // picker y al guardar/reabrir. Cada item es atomico; el unico separador entre
  // items es "\n".
  return [
    ...new Set(
      source
        .flatMap((value) =>
            String(value || "")
              .split(/\n/g)
              .map((item) => toStringSafe(item))
          )
          .filter((item) => Boolean(item) && !isStructuredPlaceholderValue(item))
    ),
  ];
}

function buildEmptyStudentOverride() {
  return {
    enabled: false,
    processKey: "",
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
      const processKey = toStringSafe(source.processKey || source.processRef);
      if (!source.enabled && !processKey) {
        return;
      }

      const normalized = {
        enabled: Boolean(source.enabled),
        processKey,
        tareas: toStringSafe(source.tareas),
        etiquetas: normalizeListValues(source.etiquetas),
        componenteCorporal: normalizeListValues(source.componenteCorporal),
        componenteTecnico: normalizeListValues(source.componenteTecnico),
        componenteTeorico: normalizeListValues(source.componenteTeorico),
        componenteObras: normalizeListValues(source.componenteObras),
      };

      if (
        !normalized.enabled &&
        !normalized.processKey &&
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
  return normalizeListValues(values).join("  -  ");
}

function cleanupView() {
  if (unsubscribeView) {
    unsubscribeView();
    unsubscribeView = null;
  }
  if (draftInputDebounceTimer) {
    clearTimeout(draftInputDebounceTimer);
    draftInputDebounceTimer = null;
  }
  if (groupSearchDebounceTimer) {
    clearTimeout(groupSearchDebounceTimer);
    groupSearchDebounceTimer = null;
  }

  viewRoot = null;
  currentNavigateTo = null;
  currentSubscribe = null;
  currentEditorStudentKey = null;
  currentEditorMode = CONFIG?.modes?.individual || "individual";
  currentEditorProcessKey = "";
  currentEditingBitacoraId = "";
}

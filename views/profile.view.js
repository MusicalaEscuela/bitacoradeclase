// js/views/profile.view.js

import { CONFIG } from "../config.js";
import { canViewStudent, resolveUserAccess } from "../authz.js";
import {
  getState,
  getSelectedStudentId,
  getSelectedStudentBitacoras,
  getStudentGoals,
  getStudentRoute,
  setAppError,
  clearAppError,
  setBitacorasForStudent,
  setBitacorasLoading,
  setSelectedStudent,
  setStudentGoals,
  setStudentProfile,
  setStudentRoute,
} from "../state.js";
import { getBitacorasByStudent } from "../api/bitacoras.api.js";
import { getStudentProfile } from "../api/students.api.js";
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
  normalizeBitacorasResponse as normalizeBitacorasResponseShared,
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
let currentProfileStudentKey = null;

const LEARNING_ROUTE_PRESET = Object.freeze([
  {
    id: "exp1-corporal-postura",
    component: "corporal",
    experience: 1,
    order: 1,
    title: "Postura base y respiracion consciente",
    description: "Reconoce postura, relajacion inicial y pulso corporal en clase.",
  },
  {
    id: "exp1-tecnico-do-mayor",
    component: "tecnico",
    experience: 1,
    order: 1,
    title: "Escala de Do mayor",
    description: "Ejecuta la escala de Do mayor con digitacion y tempo guiado.",
  },
  {
    id: "exp1-teorico-notas",
    component: "teorico",
    experience: 1,
    order: 1,
    title: "Lectura inicial de notas y figuras",
    description: "Relaciona notas basicas, pulso y figuras de duracion simples.",
  },
  {
    id: "exp1-obras-frase",
    component: "obras",
    experience: 1,
    order: 1,
    title: "Primera obra corta completa",
    description: "Interpreta una obra breve manteniendo inicio, desarrollo y cierre.",
  },
  {
    id: "exp2-corporal-pulso",
    component: "corporal",
    experience: 2,
    order: 2,
    title: "Disociacion y pulso estable",
    description: "Mantiene pulso corporal mientras coordina manos o desplazamientos.",
  },
  {
    id: "exp2-tecnico-arpegios",
    component: "tecnico",
    experience: 2,
    order: 2,
    title: "Arpegios y cambios de patron",
    description: "Resuelve arpegios basicos o cambios de patron sin detenerse.",
  },
  {
    id: "exp2-teorico-compas",
    component: "teorico",
    experience: 2,
    order: 2,
    title: "Compas y subdivision",
    description: "Identifica compas, subdivision y acentos de una pieza sencilla.",
  },
  {
    id: "exp2-obras-expresion",
    component: "obras",
    experience: 2,
    order: 2,
    title: "Obra con dinamicas y memoria",
    description: "Interpreta repertorio corto con dinamicas basicas y seguridad.",
  },
  {
    id: "exp3-corporal-autonomia",
    component: "corporal",
    experience: 3,
    order: 3,
    title: "Preparacion corporal autonoma",
    description: "Inicia su calentamiento sin depender de guia constante.",
  },
  {
    id: "exp3-tecnico-velocidad",
    component: "tecnico",
    experience: 3,
    order: 3,
    title: "Escalas y tecnica con mayor fluidez",
    description: "Sostiene tecnica con precision, limpieza y control de tempo.",
  },
  {
    id: "exp3-teorico-analisis",
    component: "teorico",
    experience: 3,
    order: 3,
    title: "Analisis basico de repertorio",
    description: "Reconoce forma, tonalidad o recursos basicos en su repertorio.",
  },
  {
    id: "exp3-obras-presentacion",
    component: "obras",
    experience: 3,
    order: 3,
    title: "Repertorio listo para muestra",
    description: "Presenta una obra completa con intencion musical y continuidad.",
  },
]);

const ROUTE_COMPONENTS = Object.freeze([
  { id: "corporal", label: "Componente corporal" },
  { id: "tecnico", label: "Componente tecnico" },
  { id: "teorico", label: "Componente teorico" },
  { id: "obras", label: "Componente de obras" },
]);

const ROUTE_EXPERIENCES = Object.freeze([1, 2, 3]);

export async function beforeEnter({ payload, navigateTo } = {}) {
  clearAppError();

  let state = getState();
  const access = resolveUserAccess(state?.auth?.user);
  const requestedStudentRef = resolveStudentRefFromPayload(payload);
  const fallbackSelectedId = getSelectedStudentId();
  const selectedStudentRef =
    access.role === CONFIG.roles.student
      ? access.linkedStudentId || fallbackSelectedId || null
      : requestedStudentRef || fallbackSelectedId || null;

  let student = getStudentFromState(state, selectedStudentRef);

  if (!student && access.role === CONFIG.roles.student && selectedStudentRef) {
    student = await ensureStudentLoadedForProfile(selectedStudentRef);
    state = getState();
  }

  if (!student || !canViewStudent(state?.auth?.user, getStudentIdentity(student))) {
    setAppError("No hay estudiante seleccionado.");
    if (access.role !== CONFIG.roles.student && typeof navigateTo === "function") {
      navigateTo(CONFIG.routes.search);
    }
    return;
  }

  currentProfileStudentKey = getStudentIdentity(student);
  if (access.role !== CONFIG.roles.student) {
    await ensureStudentBitacorasLoaded(student);
  }
  ensureLearningRouteInitialized(student);
}

async function ensureStudentLoadedForProfile(studentRef) {
  const safeStudentRef = toStringSafe(studentRef);
  if (!safeStudentRef) return null;

  try {
    const profile = await getStudentProfile(safeStudentRef);
    if (!profile) return null;

    setStudentProfile(safeStudentRef, profile);
    setSelectedStudent({
      ...profile,
      id:
        profile?.id ||
        profile?.studentId ||
        profile?.studentKey ||
        safeStudentRef,
      studentId:
        profile?.studentId ||
        profile?.studentKey ||
        safeStudentRef,
      studentKey: profile?.studentKey || safeStudentRef,
    });

    return getStudentFromState(getState(), safeStudentRef);
  } catch (error) {
    console.error("Error cargando perfil de estudiante para profile:", error);
    return null;
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

  currentProfileStudentKey = getStudentIdentity(student);

  root.innerHTML = buildProfileMarkup(student, safeState, safeConfig);

  bindProfileEvents(student);
  renderReactiveBlocks(getState(), safeConfig, currentProfileStudentKey);
  setupSubscription(safeConfig, currentProfileStudentKey);
}

export async function afterEnter() {
  const focusTarget = viewRoot?.querySelector(".profile-card__name");
  if (focusTarget) {
    focusTarget.setAttribute("tabindex", "-1");
    focusTarget.focus();
  }
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
      preferredStudentRef || currentProfileStudentKey
    );

    if (!student) {
      viewRoot.innerHTML = renderMissingStudent();
      bindMissingStateEvents();
      return;
    }

    currentProfileStudentKey = getStudentIdentity(student);
    renderReactiveBlocks(state, config, currentProfileStudentKey);
  });
}

function buildProfileMarkup(student, state, config) {
  const bitacoras = getBitacorasFromState(student);
  const isAuthenticated = Boolean(state?.auth?.isAuthenticated);
  const access = resolveUserAccess(state?.auth?.user);
  const isStudentView = access.role === CONFIG.roles.student;
  const title =
    config?.app?.name ||
    config?.appName ||
    config?.title ||
    "Bitácoras de Clase";

  return `
    <section class="view-shell view-shell--profile">
      <header class="view-header">
        <div class="view-header__content">
          <p class="view-eyebrow">${escapeHtml(title)}</p>
          <h1 class="view-title">Perfil del estudiante</h1>
          <p class="view-description">
            Revisen la información principal del estudiante y consulten su historial
            sin ponerse a perseguir datos por toda la interfaz como si el sistema
            jugara a las escondidas.
          </p>
        </div>

        <div class="view-header__actions">
          <button
            type="button"
            class="btn btn--ghost"
            id="profile-back-btn"
          >
            Volver a búsqueda
          </button>
          <button
            type="button"
            class="btn btn--primary"
            id="profile-open-editor-btn"
          >
            Abrir editor
          </button>
        </div>
      </header>

      <section class="profile-layout">
        <div class="profile-main">
          <article class="card profile-card">
            <header class="profile-card__header">
              <div class="profile-card__identity">
                <p class="profile-card__eyebrow">Estudiante seleccionado</p>
                <h2 class="profile-card__name">${escapeHtml(getStudentName(student))}</h2>
                <p class="profile-card__doc">${escapeHtml(getStudentDocument(student) || "Sin documento")}</p>
              </div>

              <div class="profile-card__badges" id="profile-badges">
                ${renderStudentBadges(student)}
              </div>
            </header>

            <dl class="profile-grid" id="profile-grid">
              ${renderProfileGrid(student)}
            </dl>
          </article>

          <section class="card route-panel">
            <header class="panel-header route-panel__header">
              <div class="panel-header__content">
                <p class="panel-header__eyebrow">Ruta</p>
                <h2 class="panel-header__title">Ruta de aprendizaje</h2>
                <p class="panel__description">
                  Ejemplo progresivo por componentes para visualizar avances, experiencia actual y logros del proceso.
                </p>
              </div>
            </header>

            <div id="profile-route-content">
              ${renderLearningRoute(student)}
            </div>
          </section>
        </div>

        <aside class="profile-side">
          <section class="card profile-summary">
            <header class="panel-header">
              <div>
                <p class="panel-header__eyebrow">Resumen</p>
                <h2 class="panel-header__title">Vista rápida</h2>
              </div>
            </header>

            <div id="profile-summary-content">
              ${renderSummary(student, bitacoras)}
            </div>
          </section>

          <section class="card profile-history">
            <header class="panel-header profile-history__header">
              <div>
                <p class="panel-header__eyebrow">Historial</p>
                <h2 class="panel-header__title">Últimas bitácoras</h2>
              </div>

              <button
                type="button"
                class="btn btn--ghost btn--sm"
                id="profile-refresh-history-btn"
              >
                Recargar
              </button>
            </header>

            <div id="profile-history-content">
              ${renderHistoryPreview(bitacoras, config, isAuthenticated)}
            </div>
          </section>
        </aside>
      </section>
    </section>
  `;
}

function bindProfileEvents(student) {
  if (!viewRoot) return;

  const access = resolveUserAccess(getState()?.auth?.user);
  const isStudentView = access.role === CONFIG.roles.student;

  const backBtn = viewRoot.querySelector("#profile-back-btn");
  const openEditorBtn = viewRoot.querySelector("#profile-open-editor-btn");
  const refreshBtn = viewRoot.querySelector("#profile-refresh-history-btn");
  const historyContainer = viewRoot.querySelector("#profile-history-content");
  const routeContainer = viewRoot.querySelector("#profile-route-content");

  if (isStudentView) {
    backBtn?.remove();
    openEditorBtn?.remove();
    refreshBtn?.remove();

    if (historyContainer) {
      historyContainer.innerHTML = renderStudentHistoryLocked();
    }
  }

  if (backBtn) {
    backBtn.addEventListener("click", () => {
      goToSearch();
    });
  }

  if (openEditorBtn) {
    openEditorBtn.addEventListener("click", () => {
      goToEditor(student);
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      await reloadHistory(student);
    });
  }

  if (historyContainer) {
    historyContainer.addEventListener("click", (event) => {
      const actionButton = event.target.closest("[data-history-action]");
      if (!actionButton) return;

      const action = actionButton.dataset.historyAction;

      if (action === "open-editor") {
        goToEditor(student);
      }

      if (action === "open-group-editor") {
        goToEditor(student, { mode: CONFIG.modes.group });
      }
    });
  }

  if (routeContainer) {
    routeContainer.addEventListener("change", (event) => {
      const checkbox = event.target.closest("[data-route-goal-check]");
      if (!checkbox) return;

      const goalId = checkbox.getAttribute("data-route-goal-check");
      if (!goalId || !checkbox.checked) return;

      completeLearningGoal(student, goalId);
    });
  }
}

function bindMissingStateEvents() {
  if (!viewRoot) return;

  const backBtn = viewRoot.querySelector("#profile-missing-back-btn");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      goToSearch();
    });
  }
}

function renderReactiveBlocks(state, config, preferredStudentRef = null) {
  const student = getStudentFromState(
    state,
    preferredStudentRef || currentProfileStudentKey
  );

  if (!student || !viewRoot) return;

  const summaryContainer = viewRoot.querySelector("#profile-summary-content");
  const historyContainer = viewRoot.querySelector("#profile-history-content");
  const routeContainer = viewRoot.querySelector("#profile-route-content");
  const titleNode = viewRoot.querySelector(".profile-card__name");
  const docNode = viewRoot.querySelector(".profile-card__doc");
  const gridNode = viewRoot.querySelector("#profile-grid");
  const badgesNode = viewRoot.querySelector("#profile-badges");

  const bitacoras = getBitacorasFromState(student);

  if (titleNode) {
    titleNode.textContent = getStudentName(student);
  }

  if (docNode) {
    docNode.textContent = getStudentDocument(student) || "Sin documento";
  }

  if (badgesNode) {
    badgesNode.innerHTML = renderStudentBadges(student);
  }

  if (gridNode) {
    gridNode.innerHTML = renderProfileGrid(student);
  }

  if (summaryContainer) {
    summaryContainer.innerHTML = renderSummary(student, bitacoras);
  }

  if (routeContainer) {
    routeContainer.innerHTML = renderLearningRoute(student);
  }

  if (historyContainer) {
    const access = resolveUserAccess(state?.auth?.user);
    historyContainer.innerHTML =
      access.role === CONFIG.roles.student
        ? renderStudentHistoryLocked()
        : renderHistoryPreview(bitacoras, config);
  }
}

function renderStudentHistoryLocked() {
  return `
    <div class="empty-state">
      <p class="empty-state__title">Historial no disponible</p>
      <p class="empty-state__text">
        Por ahora este perfil de estudiante muestra solo la informacion general.
      </p>
    </div>
  `;
}

function renderStudentBadges(student) {
  return `
    ${renderBadge(student.estado)}
    ${renderBadge(student.modalidad)}
    ${renderBadge(student.area || student.instrumento || student.programa)}
    ${renderBadge(student.sede)}
  `;
}

function renderProfileGrid(student) {
  return `
    ${renderProfileItem("Estado", getReadableValue(student.estado))}
    ${renderProfileItem("Edad", getReadableValue(student.edad || student.age))}
    ${renderProfileItem("Fecha de nacimiento", getReadableValue(student.fechaNacimiento || student.birthDate))}
    ${renderProfileItem("Procesos", getReadableValue(getStudentProcessesSummary(student), "Sin procesos registrados"))}
    ${renderProfileItem("Área / instrumento", getReadableValue(student.area || student.instrumento || student.programa))}
    ${renderProfileItem("Modalidad", getReadableValue(student.modalidad))}
    ${renderProfileItem("Docente", getReadableValue(student.docente || student.teacher))}
    ${renderProfileItem("Sede", getReadableValue(student.sede))}
    ${renderProfileItem("Acudiente", getReadableValue(student.acudiente || student.responsable))}
    ${renderProfileItem("Teléfono", getReadableValue(student.telefono || student.phone))}
    ${renderProfileItem("Correo", getReadableValue(student.correo || student.email))}
    ${renderProfileItem("Dirección", getReadableValue(student.direccion || student.address))}
    ${renderProfileItem("Intereses", getReadableValue(student.interesesMusicales || student.intereses))}
    ${renderProfileItem("Observaciones", getReadableValue(student.observaciones || student.notes, "Sin observaciones"))}
  `;
}

function renderSummary(student, bitacoras = []) {
  const lastBitacora = getLatestBitacora(bitacoras);
  const totalGroup = bitacoras.filter(
    (item) => normalizeMode(item.mode) === CONFIG.modes.group
  ).length;
  const totalIndividual = bitacoras.filter(
    (item) => normalizeMode(item.mode) === CONFIG.modes.individual
  ).length;

  return `
    <div class="summary-list">
      <article class="summary-item">
        <span class="summary-item__label">Total de bitácoras</span>
        <strong class="summary-item__value">${bitacoras.length}</strong>
      </article>

      <article class="summary-item">
        <span class="summary-item__label">Individuales</span>
        <strong class="summary-item__value">${totalIndividual}</strong>
      </article>

      <article class="summary-item">
        <span class="summary-item__label">Grupales</span>
        <strong class="summary-item__value">${totalGroup}</strong>
      </article>

      <article class="summary-item">
        <span class="summary-item__label">Última clase registrada</span>
        <strong class="summary-item__value">
          ${escapeHtml(
            lastBitacora
              ? formatDisplayDate(lastBitacora.fechaClase || lastBitacora.createdAt)
              : "Sin registros"
          )}
        </strong>
      </article>

      <article class="summary-item">
        <span class="summary-item__label">Último tipo de registro</span>
        <strong class="summary-item__value">
          ${escapeHtml(
            lastBitacora
              ? normalizeMode(lastBitacora.mode) === CONFIG.modes.group
                ? "Grupal"
                : "Individual"
              : "Sin registros"
          )}
        </strong>
      </article>

      <article class="summary-item">
        <span class="summary-item__label">Docente asignado</span>
        <strong class="summary-item__value">
          ${escapeHtml(getReadableValue(student.docente || student.teacher))}
        </strong>
      </article>

      <article class="summary-item">
        <span class="summary-item__label">Procesos</span>
        <strong class="summary-item__value">
          ${escapeHtml(getReadableValue(getStudentProcessesSummary(student), "Sin procesos"))}
        </strong>
      </article>
    </div>
  `;
}

function ensureLearningRouteInitialized(student) {
  const studentId = getStudentIdentity(student);
  if (!studentId) return;

  const currentRoute = getStudentRoute(studentId);
  if (currentRoute?.presetId === "musicala_base_v1" && Array.isArray(currentRoute?.history)) {
    if (Array.isArray(getStudentGoals(studentId)) && getStudentGoals(studentId).length) {
      return;
    }
  }

  const seededRoute = buildDefaultRouteState(student, currentRoute);
  setStudentRoute(studentId, seededRoute);
  setStudentGoals(studentId, buildStudentGoalsFromRoute(seededRoute));
}

function buildDefaultRouteState(student, baseRoute = {}) {
  const completedGoalIds = Array.isArray(baseRoute?.completedGoalIds)
    ? [...new Set(baseRoute.completedGoalIds.map((item) => toStringSafe(item)).filter(Boolean))]
    : [];

  const history = Array.isArray(baseRoute?.history)
    ? baseRoute.history
        .map((entry) => ({
          goalId: toStringSafe(entry?.goalId),
          title: toStringSafe(entry?.title),
          component: toStringSafe(entry?.component),
          experience: Number(entry?.experience) || 1,
          completedAt: entry?.completedAt || null,
        }))
        .filter((entry) => entry.goalId)
    : [];

  const experience = deriveCurrentExperience(completedGoalIds);
  const progress = buildRouteProgress(completedGoalIds);
  const nextByComponent = getNextGoalsByComponent(completedGoalIds);

  return {
    ...(baseRoute && typeof baseRoute === "object" ? baseRoute : {}),
    presetId: "musicala_base_v1",
    routeName: "Ruta base Musicala",
    focusArea:
      getReadableValue(student.area || student.instrumento || student.programa, "Proceso general"),
    completedGoalIds,
    history,
    currentExperience: experience,
    stage: `Experiencia ${experience}`,
    activeGoalIds: nextByComponent.map((goal) => goal.id),
    milestones: progress.milestones,
    recommendations: buildRouteRecommendations(nextByComponent),
    updatedAt: getTimestamp(new Date().toISOString()) ? new Date().toISOString() : null,
  };
}

function buildStudentGoalsFromRoute(route = {}) {
  const completedIds = new Set(
    Array.isArray(route.completedGoalIds) ? route.completedGoalIds : []
  );
  const activeIds = new Set(Array.isArray(route.activeGoalIds) ? route.activeGoalIds : []);

  return LEARNING_ROUTE_PRESET.map((goal) => ({
    id: goal.id,
    title: goal.title,
    component: goal.component,
    experience: goal.experience,
    description: goal.description,
    status: completedIds.has(goal.id)
      ? "completado"
      : activeIds.has(goal.id)
      ? "activo"
      : "bloqueado",
    progress: completedIds.has(goal.id) ? 100 : activeIds.has(goal.id) ? 50 : 0,
    updatedAt:
      route.history?.find((entry) => entry.goalId === goal.id)?.completedAt || null,
  }));
}

function buildRouteProgress(completedGoalIds = []) {
  const completed = new Set(completedGoalIds);
  const totalGoals = LEARNING_ROUTE_PRESET.length;
  const completedGoals = LEARNING_ROUTE_PRESET.filter((goal) =>
    completed.has(goal.id)
  ).length;

  const milestones = ROUTE_EXPERIENCES.map((experience) => {
    const goals = LEARNING_ROUTE_PRESET.filter(
      (goal) => goal.experience === experience
    );
    const completedGoalsInExperience = goals.filter((goal) =>
      completed.has(goal.id)
    ).length;

    return {
      experience,
      total: goals.length,
      completed: completedGoalsInExperience,
      unlocked: experience <= deriveCurrentExperience(completedGoalIds),
      done: completedGoalsInExperience === goals.length,
    };
  });

  return {
    totalGoals,
    completedGoals,
    percent: totalGoals ? Math.round((completedGoals / totalGoals) * 100) : 0,
    milestones,
  };
}

function deriveCurrentExperience(completedGoalIds = []) {
  const completed = new Set(completedGoalIds);
  let current = 1;

  ROUTE_EXPERIENCES.forEach((experience) => {
    const goals = LEARNING_ROUTE_PRESET.filter(
      (goal) => goal.experience === experience
    );
    const isDone = goals.length > 0 && goals.every((goal) => completed.has(goal.id));
    if (isDone) {
      current = Math.min(experience + 1, ROUTE_EXPERIENCES.length);
    }
  });

  return current;
}

function getNextGoalsByComponent(completedGoalIds = []) {
  const completed = new Set(completedGoalIds);

  return ROUTE_COMPONENTS.map(({ id }) =>
    LEARNING_ROUTE_PRESET.find(
      (goal) => goal.component === id && !completed.has(goal.id)
    )
  ).filter(Boolean);
}

function buildRouteRecommendations(nextGoals = []) {
  return nextGoals.slice(0, 3).map((goal) => {
    return `Siguiente foco en ${getComponentLabel(goal.component)}: ${goal.title}`;
  });
}

function getComponentLabel(componentId) {
  return (
    ROUTE_COMPONENTS.find((component) => component.id === componentId)?.label ||
    "Componente"
  );
}

function renderLearningRoute(student) {
  const access = resolveUserAccess(getState()?.auth?.user);
  const canEditRoute = access.canEditRoutes;
  const route = buildDefaultRouteState(student, getStudentRoute(getStudentIdentity(student)));
  const progress = buildRouteProgress(route.completedGoalIds);
  const history = Array.isArray(route.history) ? [...route.history].reverse() : [];
  const nextGoals = getNextGoalsByComponent(route.completedGoalIds);

  return `
    <div class="route-overview">
      <section class="route-overview__hero">
        <div>
          <p class="route-overview__kicker">${escapeHtml(route.routeName || "Ruta base Musicala")}</p>
          <h3 class="route-overview__title">${escapeHtml(route.stage || "Experiencia 1")}</h3>
          <p class="route-overview__text">
            ${escapeHtml(
              `Foco actual: ${route.focusArea || "Proceso general"} · ${progress.completedGoals} de ${progress.totalGoals} objetivos logrados.`
            )}
          </p>
        </div>

        <div class="route-overview__stats">
          <article class="route-stat">
            <span class="route-stat__label">Progreso total</span>
            <strong class="route-stat__value">${escapeHtml(String(progress.percent))}%</strong>
          </article>
          <article class="route-stat">
            <span class="route-stat__label">Experiencia actual</span>
            <strong class="route-stat__value">${escapeHtml(route.stage || "Experiencia 1")}</strong>
          </article>
        </div>
      </section>

      <section class="route-map">
        ${progress.milestones
          .map(
            (milestone) => `
              <article class="route-map__step ${milestone.done ? "is-done" : milestone.unlocked ? "is-active" : ""}">
                <div class="route-map__dot"></div>
                <p class="route-map__label">Experiencia ${escapeHtml(String(milestone.experience))}</p>
                <p class="route-map__meta">${escapeHtml(`${milestone.completed}/${milestone.total} objetivos`)}</p>
              </article>
            `
          )
          .join("")}
      </section>

      <section class="route-components">
        ${ROUTE_COMPONENTS.map((component) =>
          renderRouteComponentCard(component, route, canEditRoute)
        ).join("")}
      </section>

      <section class="route-history-grid">
        <article class="route-history-card">
          <p class="route-history-card__title">Logros recientes</p>
          ${
            history.length
              ? `<div class="route-log-list">
                  ${history
                    .slice(0, 8)
                    .map(
                      (entry) => `
                        <article class="route-log-item">
                          <p class="route-log-item__title">${escapeHtml(entry.title || "Objetivo completado")}</p>
                          <p class="route-log-item__meta">${escapeHtml(`${getComponentLabel(entry.component)} · Experiencia ${entry.experience} · ${formatDisplayDate(entry.completedAt)}`)}</p>
                        </article>
                      `
                    )
                    .join("")}
                </div>`
              : `<p class="route-history-card__empty">Aun no hay logros marcados. Cuando empieces a completar objetivos, aqui quedara el historial del proceso.</p>`
          }
        </article>

        <article class="route-history-card">
          <p class="route-history-card__title">Siguientes focos</p>
          <div class="route-focus-list">
            ${
              nextGoals.length
                ? nextGoals
                    .map(
                      (goal) => `
                        <div class="route-focus-item">
                          <span class="route-focus-item__component">${escapeHtml(getComponentLabel(goal.component))}</span>
                          <strong class="route-focus-item__title">${escapeHtml(goal.title)}</strong>
                        </div>
                      `
                    )
                    .join("")
                : `<p class="route-history-card__empty">La ruta de ejemplo ya esta completa. Podemos ampliar mas experiencias cuando quieras.</p>`
            }
          </div>
        </article>
      </section>
    </div>
  `;
}

function renderRouteComponentCard(component, route = {}, canEditRoute = false) {
  const completedIds = new Set(
    Array.isArray(route.completedGoalIds) ? route.completedGoalIds : []
  );
  const goals = LEARNING_ROUTE_PRESET.filter(
    (goal) => goal.component === component.id
  );
  const nextGoal = goals.find((goal) => !completedIds.has(goal.id)) || null;
  const completedGoals = goals.filter((goal) => completedIds.has(goal.id));

  return `
    <article class="route-component-card">
      <header class="route-component-card__header">
        <div>
          <p class="route-component-card__eyebrow">${escapeHtml(component.label)}</p>
          <h3 class="route-component-card__title">${escapeHtml(
            nextGoal ? `Objetivo activo: ${nextGoal.title}` : "Componente consolidado"
          )}</h3>
        </div>
        <span class="route-component-card__count">${escapeHtml(`${completedGoals.length}/${goals.length}`)}</span>
      </header>

      ${
        nextGoal
          ? `
            <label class="route-goal-check">
              <input
                type="checkbox"
                data-route-goal-check="${escapeHtml(nextGoal.id)}"
                ${!canEditRoute ? "disabled" : ""}
              />
              <span class="route-goal-check__body">
                <span class="route-goal-check__title">${escapeHtml(nextGoal.title)}</span>
                <span class="route-goal-check__text">${escapeHtml(nextGoal.description || "")}</span>
                <span class="route-goal-check__meta">${escapeHtml(`Experiencia ${nextGoal.experience}`)}</span>
              </span>
            </label>
          `
          : `
            <p class="route-component-card__done">
              Todos los objetivos base de este componente ya fueron logrados.
            </p>
          `
      }

      <div class="route-component-card__history">
        <p class="route-component-card__history-title">Logrados</p>
        ${
          completedGoals.length
            ? completedGoals
                .map(
                  (goal) => `
                    <span class="route-achievement-chip">
                      ${escapeHtml(goal.title)}
                    </span>
                  `
                )
                .join("")
            : `<span class="route-achievement-chip route-achievement-chip--muted">Aun sin logros marcados</span>`
        }
      </div>
    </article>
  `;
}

function completeLearningGoal(student, goalId) {
  const studentId = getStudentIdentity(student);
  if (!studentId) return;

  const goal = LEARNING_ROUTE_PRESET.find((item) => item.id === goalId);
  if (!goal) return;

  const currentRoute = buildDefaultRouteState(student, getStudentRoute(studentId));
  const completedGoalIds = new Set(currentRoute.completedGoalIds || []);
  if (completedGoalIds.has(goal.id)) return;

  completedGoalIds.add(goal.id);

  const history = Array.isArray(currentRoute.history) ? [...currentRoute.history] : [];
  history.push({
    goalId: goal.id,
    title: goal.title,
    component: goal.component,
    experience: goal.experience,
    completedAt: new Date().toISOString(),
  });

  const nextRoute = buildDefaultRouteState(student, {
    ...currentRoute,
    completedGoalIds: [...completedGoalIds],
    history,
  });

  setStudentRoute(studentId, nextRoute);
  setStudentGoals(studentId, buildStudentGoalsFromRoute(nextRoute));
}

function renderHistoryPreview(items = [], config, isAuthenticated = true) {
  if (!isAuthenticated) {
    return `
      <div class="empty-state">
        <p class="empty-state__title">Historial protegido</p>
        <p class="empty-state__text">
          Inicia sesiÃ³n con Google para consultar las bitÃ¡coras de este estudiante.
        </p>
      </div>
    `;
  }

  if (!Array.isArray(items) || !items.length) {
    return `
      <div class="empty-state">
        <p class="empty-state__title">Sin bitácoras</p>
        <p class="empty-state__text">
          ${escapeHtml(
            config?.text?.emptyBitacoras ||
              "Este estudiante aún no tiene bitácoras registradas."
          )}
        </p>
        <div class="empty-state__actions">
          <button
            type="button"
            class="btn btn--primary btn--sm"
            data-history-action="open-editor"
          >
            Crear primera bitácora
          </button>
          ${
            CONFIG?.features?.allowGroupBitacoras
              ? `
                <button
                  type="button"
                  class="btn btn--ghost btn--sm"
                  data-history-action="open-group-editor"
                >
                  Crear grupal
                </button>
              `
              : ""
          }
        </div>
      </div>
    `;
  }

  const latestItems = sortBitacorasByDate(items).slice(0, 5);

  return `
    <div class="history-preview-list">
      ${latestItems.map(renderHistoryCard).join("")}
    </div>
  `;
}

function renderHistoryCard(item) {
  const mode = normalizeMode(item.mode);
  const overridesCount = Object.keys(
    normalizeStudentOverrides(item.studentOverrides, item.studentIds || [])
  ).length;

  return `
    <article class="history-preview-card">
      <header class="history-preview-card__header">
        <div>
          <h3 class="history-preview-card__title">
            ${escapeHtml(item.titulo || "Sin título")}
          </h3>
          <p class="history-preview-card__date">
            ${escapeHtml(formatDisplayDate(item.fechaClase || item.createdAt))}
          </p>
        </div>

        <div class="history-preview-card__meta">
          <span class="badge">
            ${escapeHtml(mode === CONFIG.modes.group ? "Grupal" : "Individual")}
          </span>
          ${
            Array.isArray(item.studentRefs) && item.studentRefs.length > 1
              ? `<span class="badge badge--soft">${escapeHtml(`${item.studentRefs.length} estudiantes`)}</span>`
              : ""
          }
          ${
            overridesCount
              ? `<span class="badge badge--soft">${escapeHtml(`${overridesCount} ajuste${overridesCount === 1 ? "" : "s"}`)}</span>`
              : ""
          }
        </div>
      </header>

      ${
        Array.isArray(item.etiquetas) && item.etiquetas.length
          ? `
            <div class="history-preview-card__tags">
              ${item.etiquetas
                .map((tag) => `<span class="badge">${escapeHtml(tag)}</span>`)
                .join("")}
            </div>
          `
          : ""
      }

      <p class="history-preview-card__text">
        ${escapeHtml(truncateText(item.contenido || "", 180))}
      </p>

      ${
        Array.isArray(item.studentRefs) && item.studentRefs.length > 1
          ? `
            <div class="history-preview-card__group">
              <p class="history-preview-card__group-title">Incluye</p>
              <div class="history-preview-card__tags">
                ${item.studentRefs
                  .slice(0, 4)
                  .map(
                    (student) => `
                      <span class="badge badge--soft">
                        ${escapeHtml(student.name || student.id || "Estudiante")}
                      </span>
                    `
                  )
                  .join("")}
                ${
                  item.studentRefs.length > 4
                    ? `<span class="badge badge--soft">+${escapeHtml(item.studentRefs.length - 4)}</span>`
                    : ""
                }
              </div>
            </div>
          `
          : ""
      }
    </article>
  `;
}

async function ensureStudentBitacorasLoaded(student) {
  const studentRef = getStudentIdentity(student);
  if (!studentRef) return;

  const currentItems = getBitacorasFromState(student);
  if (currentItems.length > 0) return;

  setBitacorasLoading(true);

  try {
    const response = await getBitacorasByStudent(studentRef);
    const items = normalizeBitacorasResponse(response);

    setBitacorasForStudent(studentRef, items);

    const fallbackId = getStudentFallbackId(student);
    if (fallbackId && fallbackId !== studentRef) {
      setBitacorasForStudent(fallbackId, items);
    }
  } catch (error) {
    console.error("Error cargando bitácoras en profile:", error);
    setAppError(
      error?.message || "No se pudo cargar el historial del estudiante."
    );
  } finally {
    setBitacorasLoading(false);
  }
}

async function reloadHistory(student) {
  const studentRef = getStudentIdentity(student);
  if (!studentRef) return;

  setBitacorasLoading(true);

  try {
    clearAppError();

    const response = await getBitacorasByStudent(studentRef);
    const items = normalizeBitacorasResponse(response);

    setBitacorasForStudent(studentRef, items);

    const fallbackId = getStudentFallbackId(student);
    if (fallbackId && fallbackId !== studentRef) {
      setBitacorasForStudent(fallbackId, items);
    }
  } catch (error) {
    console.error("Error recargando historial en profile:", error);
    setAppError(error?.message || "No se pudo recargar el historial.");
  } finally {
    setBitacorasLoading(false);
  }
}

function getBitacorasFromState(studentOrRef) {
  const studentRef =
    studentOrRef && typeof studentOrRef === "object"
      ? getStudentIdentity(studentOrRef)
      : toStringSafe(studentOrRef);

  const fallbackId =
    studentOrRef && typeof studentOrRef === "object"
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

function normalizeBitacorasResponse(response) {
  return normalizeBitacorasResponseShared(response, normalizeBitacora);
}

function normalizeBitacora(item) {
  if (!item || typeof item !== "object") return null;

  const fallbackId =
    item.id ||
    item.bitacoraId ||
    item._id ||
    `${item.fechaClase || item.createdAt || "bitacora"}-${
      item.titulo || item.title || "sin-titulo"
    }`;

  return {
    ...item,
    id: String(fallbackId),
    mode: normalizeMode(item.mode || item.modo || CONFIG.modes.individual),
    titulo: item.titulo || item.title || "Bitácora sin título",
    contenido: item.contenido || item.content || "",
    etiquetas: normalizeTags(item.etiquetas || item.tags || []),
    fechaClase: item.fechaClase || item.fecha || item.classDate || "",
    studentIds: normalizeStudentIds(item.studentIds || [item.studentId]),
    studentRefs: normalizeStudentRefs(item.studentRefs || []),
    studentOverrides: normalizeStudentOverrides(
      item.studentOverrides || item.overrides,
      normalizeStudentIds(item.studentIds || [item.studentId])
    ),
    createdAt:
      item.createdAt || item.created_at || item.fechaRegistro || "",
  };
}

function normalizeStudentOverrides(overrides = {}, allowedStudentIds = []) {
  const next = {};
  const allowedIds = new Set(normalizeStudentIds(allowedStudentIds));

  Object.entries(overrides && typeof overrides === "object" ? overrides : {}).forEach(
    ([studentId, value]) => {
      const safeStudentId = toStringSafe(studentId);
      if (!safeStudentId || (allowedIds.size && !allowedIds.has(safeStudentId))) {
        return;
      }

      const source = value && typeof value === "object" ? value : {};
      const normalized = {
        enabled: Boolean(source.enabled),
        tareas: toStringSafe(source.tareas),
        etiquetas: normalizeTags(source.etiquetas || []),
        componenteCorporal: normalizeTags(source.componenteCorporal || []),
        componenteTecnico: normalizeTags(source.componenteTecnico || []),
        componenteTeorico: normalizeTags(source.componenteTeorico || []),
        componenteObras: normalizeTags(source.componenteObras || []),
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

/**
 * Se deja local a propósito:
 * la versión string original NO deduplicaba, y no vale la pena meter
 * un cambio sutil de comportamiento en este archivo.
 */
function normalizeTags(tags) {
  if (Array.isArray(tags)) {
    return [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))];
  }

  if (typeof tags === "string") {
    return tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  return [];
}

/**
 * Se deja local para respetar exactamente el criterio previo:
 * ordena por fechaClase o createdAt, sin meter updatedAt como fallback.
 */
function sortBitacorasByDate(items = []) {
  return [...items].sort((a, b) => {
    const dateA = getTimestamp(a.fechaClase || a.createdAt);
    const dateB = getTimestamp(b.fechaClase || b.createdAt);
    return dateB - dateA;
  });
}

function getLatestBitacora(items = []) {
  const sorted = sortBitacorasByDate(items);
  return sorted[0] || null;
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

function renderProfileItem(label, value) {
  return `
    <div class="profile-grid__item">
      <dt class="profile-grid__label">${escapeHtml(label)}</dt>
      <dd class="profile-grid__value">${escapeHtml(String(value ?? ""))}</dd>
    </div>
  `;
}

function renderBadge(value) {
  if (!value) return "";
  return `<span class="badge">${escapeHtml(String(value))}</span>`;
}

function renderMissingStudent() {
  return `
    <section class="view-shell view-shell--profile-missing">
      <div class="card empty-state-card">
        <p class="view-eyebrow">Perfil</p>
        <h1 class="view-title">No hay estudiante seleccionado</h1>
        <p class="view-description">
          Primero vuelvan a búsqueda y seleccionen un estudiante. El orden sigue
          siendo una idea útil, aunque a veces parezca ciencia ficción.
        </p>
        <div class="empty-state-card__actions">
          <button
            type="button"
            class="btn btn--primary"
            id="profile-missing-back-btn"
          >
            Ir a búsqueda
          </button>
        </div>
      </div>
    </section>
  `;
}

function goToSearch() {
  if (typeof currentNavigateTo !== "function") return;
  currentNavigateTo(CONFIG.routes.search);
}

function goToEditor(student, extraPayload = {}) {
  if (typeof currentNavigateTo !== "function" || !student) return;

  currentNavigateTo(CONFIG.routes.editor, {
    id: student.id,
    studentId: student.id,
    studentKey: student.studentKey || student.id,
    ...extraPayload,
  });
}

function truncateText(text, maxLength = 180) {
  const value = String(text || "");
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength).trim()}...`;
}

function cleanupView() {
  if (unsubscribeView) {
    unsubscribeView();
    unsubscribeView = null;
  }

  viewRoot = null;
  currentNavigateTo = null;
  currentSubscribe = null;
  currentProfileStudentKey = null;
}

// js/app.js

import { CONFIG } from "./config.js";
import {
  canAccessRoute,
  getDefaultViewForUser,
  getRoleLabel,
  resolveUserAccess,
} from "./authz.js";
import {
  getState,
  setState,
  subscribe,
  hydrateStateFromStorage,
  setCurrentView,
  setAppLoading,
  setAppError,
  clearAppError,
  setAuthUser,
  setAuthReady,
} from "./state.js";
import {
  loginWithGoogle,
  logoutUser,
  observeAuth,
} from "./firebase.client.js";
import { getCatalogs } from "./api/catalogs.api.js";
import { getUserAccessProfile } from "./api/users.api.js";
import {
  getStudents,
  getStudentByEmail,
  isStudentAllowedToLogIn,
} from "./api/students.api.js";

const appModules = {
  views: new Map(),
  initialized: false,
  currentUnmount: null,
  authUnsubscribe: null,
  navigationRequestId: 0,
};

const dom = {
  root: null,
  nav: null,
  status: null,
  statusText: null,
  topbarActions: null,
  authButton: null,
};

document.addEventListener("DOMContentLoaded", initApp);

async function initApp() {
  if (appModules.initialized) return;
  appModules.initialized = true;

  try {
    cacheDom();
    normalizeStaticUiText();
    ensureRoot();
    hydrateStateFromStorage();
    initAuth();
    bindGlobalEvents();
    bindHashRouting();

    subscribe(handleStateChange);
    handleStateChange(getState());

    const initialView = resolveViewFromHash() || CONFIG.app.defaultRoute;
    await navigateTo(initialView, { replaceHash: true });

    patchAppReady(true);
    logDebug("Aplicación iniciada correctamente.");
  } catch (error) {
    console.error("[Bitácoras App] Error al iniciar la aplicación:", error);
    renderFatalError(error);
  }
}

function cacheDom() {
  dom.root =
    document.querySelector("[data-app-root]") ||
    document.querySelector("#app") ||
    null;

  dom.nav = document.querySelector("[data-app-nav]") || null;
  dom.status = document.querySelector("[data-app-status]") || null;
  dom.statusText =
    dom.status?.querySelector(".status-badge__text") || dom.status || null;
  dom.topbarActions = document.querySelector(".topbar__actions") || null;
  ensureAuthButton();
}

function ensureRoot() {
  if (dom.root) return;

  const main = document.createElement("main");
  main.id = "app";
  main.className = "workspace workspace--single";
  main.setAttribute("data-app-root", "true");
  document.body.appendChild(main);
  dom.root = main;
}

function ensureAuthButton() {
  if (!dom.topbarActions) return;

  const existing = dom.topbarActions.querySelector("[data-auth-button]");
  if (existing) {
    dom.authButton = existing;
    return;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn--ghost btn--sm topbar__auth-button";
  button.dataset.authButton = "true";
  button.dataset.action = "login-google";
  button.textContent = "Entrar con Google";

  dom.topbarActions.appendChild(button);
  dom.authButton = button;
}

function normalizeStaticUiText() {
  const settingsButton = document.querySelector('[data-route="settings"]');
  const settingsLabel = settingsButton?.querySelector(".nav-chip__label");

  if (settingsButton) {
    settingsButton.title = "Ir a configuracion";
  }

  if (settingsLabel) {
    settingsLabel.textContent = "Configuracion";
  }
}

function bindGlobalEvents() {
  document.addEventListener("click", handleGlobalClick);
}

function bindHashRouting() {
  window.addEventListener("hashchange", async () => {
    const hashView = resolveViewFromHash();
    const currentView = getState()?.app?.currentView || "";

    if (!hashView || hashView === currentView) return;

    await navigateTo(hashView, {
      updateStateOnly: true,
      replaceHash: true,
    });
  });
}

async function handleGlobalClick(event) {
  const loginTrigger = event.target.closest("[data-action='login-google']");
  if (loginTrigger) {
    event.preventDefault();
    await handleLogin();
    return;
  }

  const logoutTrigger = event.target.closest("[data-action='logout-user']");
  if (logoutTrigger) {
    event.preventDefault();
    await handleLogout();
    return;
  }

  const routeTrigger = event.target.closest("[data-route]");
  if (routeTrigger) {
    event.preventDefault();
    const targetView = routeTrigger.dataset.route;
    if (targetView) {
      await navigateTo(targetView);
    }
    return;
  }

  const backTrigger = event.target.closest("[data-action='go-back']");
  if (backTrigger) {
    event.preventDefault();
    window.history.back();
    return;
  }

  const reloadAppTrigger = event.target.closest("[data-action='reload-app']");
  if (reloadAppTrigger) {
    event.preventDefault();
    window.location.reload();
    return;
  }

  const reloadFatalTrigger = event.target.closest("[data-action='reload-fatal']");
  if (reloadFatalTrigger) {
    event.preventDefault();
    window.location.reload();
  }
}

function handleStateChange(state) {
  updateDocumentTitle(state);
  updateNavState(state);
  updateStatus(state);
  updateAuthButton(state);
}

function initAuth() {
  if (typeof appModules.authUnsubscribe === "function") {
    appModules.authUnsubscribe();
  }

  setAuthReady(false);

  appModules.authUnsubscribe = observeAuth(handleObservedAuthUser);
  /*
    setAuthUser(user);

    if (user) {
      clearAppError();
      logDebug(`Sesión activa: ${user.email || user.uid}`);
      return;
    }

    logDebug("Sin sesión activa en Firebase Auth.");
  });
  */
}

async function handleObservedAuthUser(user) {
  if (user) {
    try {
      let accessProfile = null;
      try {
        accessProfile = await getUserAccessProfile(user);
      } catch (error) {
        console.warn(
          "[Bitacoras App] No se pudo cargar el perfil de acceso:",
          error
        );
      }
      const bootstrapAdmins = Array.isArray(CONFIG.access?.bootstrapAdminEmails)
        ? CONFIG.access.bootstrapAdminEmails.map((item) =>
            String(item || "").trim().toLowerCase()
          )
        : [];
      const email = String(user?.email || "").trim().toLowerCase();
      const isBootstrapAdmin = bootstrapAdmins.includes(email);
      const explicitRole = String(accessProfile?.role || "").trim().toLowerCase();
      const allowedStudentAccessProfile = isAllowedStudentAccessProfile(accessProfile);
      const deniedStudentAccessProfile = isDeniedStudentAccessProfile(accessProfile);
      const shouldCheckTeacher =
        !isBootstrapAdmin && explicitRole !== CONFIG.roles.admin;
      const matchedTeacher = shouldCheckTeacher
        ? await findTeacherByEmail(email)
        : null;
      const shouldCheckStudent =
        !isBootstrapAdmin &&
        explicitRole !== CONFIG.roles.admin &&
        explicitRole !== CONFIG.roles.teacher &&
        !matchedTeacher;
      const studentAccess = shouldCheckStudent
        ? await findStudentAccessByEmail(email)
        : { student: null, blockedByStatus: false, lookupFailed: false };
      const matchedStudent = studentAccess.student;
      const canUseSyncedStudentProfile =
        Boolean(allowedStudentAccessProfile) && studentAccess.lookupFailed;
      const deniedByStudentStatus =
        deniedStudentAccessProfile || studentAccess.blockedByStatus;
      const mergedUser = {
        ...user,
        role: isBootstrapAdmin
          ? CONFIG.roles.admin
          : explicitRole === CONFIG.roles.admin
          ? CONFIG.roles.admin
          : explicitRole === CONFIG.roles.teacher || matchedTeacher
          ? CONFIG.roles.teacher
          : matchedStudent || canUseSyncedStudentProfile
          ? CONFIG.roles.student
          : "unauthorized",
        linkedStudentId:
          matchedStudent?.studentKey ||
          matchedStudent?.id ||
          allowedStudentAccessProfile?.studentId ||
          allowedStudentAccessProfile?.studentKey ||
          "",
        active:
          isBootstrapAdmin ||
          explicitRole === CONFIG.roles.admin ||
          explicitRole === CONFIG.roles.teacher ||
          matchedTeacher
            ? true
            : Boolean(matchedStudent || canUseSyncedStudentProfile),
        studentStatus:
          matchedStudent?.estado ||
          matchedStudent?.status ||
          allowedStudentAccessProfile?.studentStatus ||
          "",
        accessDeniedReason: deniedByStudentStatus ? "student-status" : "",
      };

      setAuthUser(mergedUser);
      clearAppError();

      if (resolveUserAccess(mergedUser).role === "unauthorized") {
        if (mergedUser.accessDeniedReason === "student-status") {
          setAppError(
            "Tu estado actual no habilita el ingreso como estudiante."
          );
          renderInlineError(
            "Tu correo esta registrado, pero tu estado actual no permite ingresar. Solo pueden entrar estudiantes con estado Activo, Activo no registro, Activo en pausa o Inactivo en pausa."
          );
          return;
        }

        setAppError(
          "Este correo no tiene acceso habilitado. Debe existir como admin, docente o estudiante valido."
        );
        renderInlineError(
          "Tu cuenta no esta autorizada para entrar a Musicala. Si crees que es un error, revisa que tu correo exista en admins, docentes o estudiantes."
        );
        return;
      }

      logDebug(
        `Sesion activa: ${mergedUser.email || mergedUser.uid} (${getRoleLabel(
          mergedUser.role
        )})`
      );

      const currentView =
        getState()?.app?.currentView || CONFIG.app.defaultRoute;

      if (!canAccessRoute(mergedUser, currentView)) {
        await navigateTo(getDefaultViewForUser(mergedUser), {
          replaceHash: true,
        });
      }
      return;
    } catch (error) {
      console.warn(
        "[Bitacoras App] No se pudo resolver el acceso del usuario:",
        error
      );
      setAuthUser(user);
      return;
    }
  }

  setAuthUser(null);
  logDebug("Sin sesion activa en Firebase Auth.");
}

function isAllowedStudentAccessProfile(accessProfile = null) {
  const safeRole = String(accessProfile?.role || "").trim().toLowerCase();
  const studentId = String(
    accessProfile?.studentId || accessProfile?.studentKey || ""
  ).trim();

  return (
    safeRole === CONFIG.roles.student &&
    accessProfile?.active === true &&
    Boolean(studentId)
  )
    ? accessProfile
    : null;
}

function isDeniedStudentAccessProfile(accessProfile = null) {
  const safeRole = String(accessProfile?.role || "").trim().toLowerCase();
  const studentId = String(
    accessProfile?.studentId || accessProfile?.studentKey || ""
  ).trim();

  return (
    safeRole === CONFIG.roles.student &&
    Boolean(studentId) &&
    accessProfile?.active === false
  );
}

async function findStudentAccessByEmail(email) {
  const safeEmail = String(email || "").trim().toLowerCase();
  if (!safeEmail) {
    return {
      student: null,
      blockedByStatus: false,
      lookupFailed: false,
    };
  }

  let blockedByStatus = false;
  let lookupFailed = false;

  try {
    const directMatch = await getStudentByEmail(safeEmail);
    if (directMatch) {
      if (isStudentAllowedToLogIn(directMatch)) {
        return {
          student: directMatch,
          blockedByStatus: false,
          lookupFailed: false,
        };
      }

      blockedByStatus = true;
    }
  } catch (error) {
    lookupFailed = true;
    console.warn(
      "[Bitacoras App] No se pudo resolver estudiante por email directo:",
      error
    );
  }

  try {
    const students = await getStudents({
      includeInactive: true,
      estado: "todos",
    });

    const matchedStudent =
      students.find((student) => {
        const candidates = [
          student?.email,
          student?.correo,
          student?.correoElectronico,
          student?.mail,
        ]
          .map((value) => String(value || "").trim().toLowerCase())
          .filter(Boolean);

        return candidates.includes(safeEmail);
      }) || null;

    if (!matchedStudent) {
      return {
        student: null,
        blockedByStatus,
        lookupFailed: false,
      };
    }

    if (isStudentAllowedToLogIn(matchedStudent)) {
      return {
        student: matchedStudent,
        blockedByStatus: false,
        lookupFailed: false,
      };
    }

    return {
      student: null,
      blockedByStatus: true,
      lookupFailed: false,
    };
  } catch (error) {
    console.warn("[Bitacoras App] No se pudo resolver estudiante por correo:", error);
    return {
      student: null,
      blockedByStatus,
      lookupFailed,
    };
  }
}

async function findTeacherByEmail(email) {
  const safeEmail = String(email || "").trim().toLowerCase();
  if (!safeEmail) return null;

  try {
    const catalogs = await getCatalogs();
    const catalogTeachers = Array.isArray(catalogs?.docentes)
      ? catalogs.docentes
      : [];

    const matchedCatalogTeacher = catalogTeachers.find((teacher) => {
      const candidates = [
        teacher?.email,
        teacher?.correo,
        teacher?.correoElectronico,
        teacher?.mail,
      ]
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean);

      return candidates.includes(safeEmail);
    });

    if (matchedCatalogTeacher) {
      return matchedCatalogTeacher;
    }
  } catch (error) {
    console.warn(
      "[Bitacoras App] No se pudo resolver docente desde catalogos:",
      error
    );
  }

  return null;
}

async function navigateTo(viewName, options = {}) {
  const {
    replaceHash = false,
    updateStateOnly = true,
    payload: explicitPayload = null,
    ...payloadShorthand
  } = options;
  const payload =
    explicitPayload ||
    (Object.keys(payloadShorthand).length ? payloadShorthand : null);

  const safeView = normalizeViewName(viewName);
  const authUser = getState()?.auth?.user || null;
  const navigationRequestId = ++appModules.navigationRequestId;

  if (!safeView) {
    const message = `La vista "${String(viewName || "").trim()}" no existe.`;
    setAppError(message);
    renderInlineError(message);
    return;
  }

  if (!canAccessRoute(authUser, safeView)) {
    const fallbackView = getDefaultViewForUser(authUser);
    setAppError("No tienes permisos para abrir esa vista.");
    if (safeView !== fallbackView) {
      await navigateTo(fallbackView, {
        replaceHash: true,
        payload,
      });
    }
    return;
  }

  if (updateStateOnly) {
    setCurrentView(safeView);
  }

  syncHashWithView(safeView, replaceHash);
  clearAppError();
  setAppLoading(true);
  renderRouteLoadingState(safeView);

  try {
    await runCurrentUnmount();
    if (!isCurrentNavigationRequest(navigationRequestId)) return;

    const viewModule = await loadViewModule(safeView);
    if (!isCurrentNavigationRequest(navigationRequestId)) return;

    if (!viewModule || typeof viewModule.render !== "function") {
      throw new Error(
        `La vista "${safeView}" no exporta una función render().`
      );
    }

    let context = {
      root: dom.root,
      state: getState(),
      config: CONFIG,
      navigateTo,
      payload,
      subscribe,
    };

    if (typeof viewModule.beforeEnter === "function") {
      await viewModule.beforeEnter(context);
      if (!isCurrentNavigationRequest(navigationRequestId)) return;
      context = { ...context, state: getState() };
    }

    context = { ...context, state: getState() };

    const renderResult = await viewModule.render(context);
    if (!isCurrentNavigationRequest(navigationRequestId)) {
      if (typeof renderResult === "function") {
        await renderResult();
      } else if (renderResult && typeof renderResult.destroy === "function") {
        await renderResult.destroy();
      }
      return;
    }

    if (typeof renderResult === "function") {
      appModules.currentUnmount = renderResult;
    } else if (renderResult && typeof renderResult.destroy === "function") {
      appModules.currentUnmount = () => renderResult.destroy();
    } else {
      appModules.currentUnmount = null;
    }

    if (typeof viewModule.afterEnter === "function") {
      await viewModule.afterEnter({
        ...context,
        state: getState(),
      });
      if (!isCurrentNavigationRequest(navigationRequestId)) return;
    }

    logDebug(`Vista cargada: ${safeView}`);
  } catch (error) {
    if (!isCurrentNavigationRequest(navigationRequestId)) {
      return;
    }

    console.error(
      `[Bitácoras App] Error cargando la vista "${safeView}":`,
      error
    );

    const message =
      error?.message || `No se pudo cargar la vista "${safeView}".`;

    setAppError(message);

    renderInlineError(
      `No se pudo abrir la vista "${safeView}". ${
        error?.message ? `Detalle: ${error.message}` : ""
      }`
    );
  } finally {
    setAppLoading(false);
  }
}

async function runCurrentUnmount() {
  if (typeof appModules.currentUnmount !== "function") return;

  try {
    await appModules.currentUnmount();
  } catch (error) {
    console.warn("[Bitácoras App] Error limpiando la vista anterior:", error);
  } finally {
    appModules.currentUnmount = null;
  }
}

async function loadViewModule(viewName) {
  if (appModules.views.has(viewName)) {
    return appModules.views.get(viewName);
  }

  const importMap = {
    [CONFIG.routes.search]: () => import("./views/search.view.js"),
    [CONFIG.routes.profile]: () => import("./views/profile.view.js"),
    [CONFIG.routes.editor]: () => import("./views/editor.view.js"),
    [CONFIG.routes.libraries]: () => import("./views/libraries.view.js"),
    [CONFIG.routes.settings]: () => import("./views/settings.view.js"),
  };

  const importer = importMap[viewName];

  if (!importer) {
    throw new Error(`No existe importador para la vista "${viewName}".`);
  }

  const module = await importer();
  appModules.views.set(viewName, module);
  return module;
}

function resolveViewFromHash() {
  const hash = window.location.hash.replace(/^#/, "").trim();
  return normalizeViewName(hash);
}

function normalizeViewName(viewName) {
  const value = String(viewName || "")
    .trim()
    .toLowerCase();

  if (!value) return null;

  const allowedViews = Object.values(CONFIG.routes);
  return allowedViews.includes(value) ? value : null;
}

function syncHashWithView(viewName, replaceHash = false) {
  const nextHash = `#${viewName}`;
  const currentHash = window.location.hash || "";

  if (currentHash === nextHash) return;

  if (replaceHash) {
    const newUrl = `${window.location.pathname}${window.location.search}${nextHash}`;
    window.history.replaceState({}, "", newUrl);
    return;
  }

  window.location.hash = nextHash;
}

function isCurrentNavigationRequest(requestId) {
  return appModules.navigationRequestId === requestId;
}

function renderRouteLoadingState(viewName) {
  if (!dom.root) return;

  const labels = {
    [CONFIG.routes.search]: "Busqueda",
    [CONFIG.routes.profile]: "Perfil",
    [CONFIG.routes.editor]: "Bitacora",
    [CONFIG.routes.settings]: "Configuracion",
    [CONFIG.routes.libraries]: "Bibliotecas",
  };

  dom.root.innerHTML = `
    <section class="view-shell">
      <div class="loading-state">
        <div>
          <p class="panel-header__eyebrow">Navegacion</p>
          <p class="loading-state__text">Abriendo ${escapeHtml(labels[viewName] || "vista")}...</p>
        </div>
      </div>
    </section>
  `;
}

function updateDocumentTitle(state) {
  const currentView = state?.app?.currentView || CONFIG.app.defaultRoute;

  const labels = {
    [CONFIG.routes.search]: "Búsqueda",
    [CONFIG.routes.profile]: "Perfil",
    [CONFIG.routes.editor]: "Bitácora",
    [CONFIG.routes.settings]: "Configuración",
  };

  document.title = `${CONFIG.app.name} | ${labels[currentView] || "App"}`;
}

function updateNavState(state) {
  if (!dom.nav) return;

  const currentView = state?.app?.currentView || "";
  const authUser = state?.auth?.user || null;

  dom.nav.querySelectorAll("[data-route]").forEach((button) => {
    const route = button.dataset.route || "";
    const allowed = canAccessRoute(authUser, route);
    const isActive = button.dataset.route === currentView;
    button.hidden = !allowed;
    button.disabled = !allowed;
    button.classList.toggle("is-active", isActive);

    if (isActive) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });
}

function updateStatus(state) {
  if (!dom.status || !dom.statusText) return;

  if (!state?.auth?.ready) {
    setStatusBadge("loading", "Verificando acceso...");
    return;
  }

  if (!state?.auth?.isAuthenticated) {
    setStatusBadge("warning", "Entrar con Google", {
      action: "login-google",
      interactive: true,
    });
    return;
  }

  if (state?.app?.loading) {
    setStatusBadge("loading", CONFIG.text.loading || "Cargando...");
    return;
  }

  if (state?.app?.saving) {
    setStatusBadge("saving", CONFIG.text.saving || "Guardando...");
    return;
  }

  if (state?.app?.error) {
    setStatusBadge("error", state.app.error);
    return;
  }

  if (state?.app?.ready) {
    const userName =
      state?.auth?.user?.name ||
      state?.auth?.user?.email ||
      "Sesión activa";

    setStatusBadge("ready", `${userName} · ${getRoleLabel(state?.auth?.user?.role)}`, {
      action: "logout-user",
      interactive: true,
    });
    return;
  }

  setStatusBadge("idle", "Sesión activa", {
    action: "logout-user",
    interactive: true,
  });
}

function setStatusBadge(status, message, options = {}) {
  if (!dom.status || !dom.statusText) return;

  const { action = "", interactive = false } = options;

  dom.status.dataset.status = status;
  dom.status.dataset.action = action;
  dom.status.classList.toggle("is-loading", status === "loading");
  dom.status.classList.toggle("is-saving", status === "saving");
  dom.status.classList.toggle("is-error", status === "error");
  dom.status.classList.toggle("is-ready", status === "ready");
  dom.status.classList.toggle("is-actionable", interactive);
  dom.status.setAttribute("role", interactive ? "button" : "status");
  dom.status.setAttribute("tabindex", interactive ? "0" : "-1");
  dom.statusText.textContent = message || "";
}

function updateAuthButton(state) {
  if (!dom.authButton) return;

  const isReady = Boolean(state?.auth?.ready);
  const isAuthenticated = Boolean(state?.auth?.isAuthenticated);
  const userLabel =
    state?.auth?.user?.name ||
    state?.auth?.user?.email ||
    "Sesión activa";

  dom.authButton.disabled = !isReady;

  if (!isReady) {
    dom.authButton.dataset.action = "";
    dom.authButton.textContent = "Verificando acceso...";
    return;
  }

  if (isAuthenticated) {
    dom.authButton.dataset.action = "logout-user";
    dom.authButton.textContent = `Salir (${userLabel})`;
    return;
  }

  dom.authButton.dataset.action = "login-google";
  dom.authButton.textContent = "Entrar con Google";
}

async function handleLogin() {
  try {
    clearAppError();
    setAppLoading(true);
    await loginWithGoogle();
  } catch (error) {
    console.error("[Bitácoras App] Error iniciando sesión:", error);
    setAppError(error?.message || "No se pudo iniciar sesión con Google.");
  } finally {
    if (isCurrentNavigationRequest(navigationRequestId)) {
      setAppLoading(false);
    }
  }
}

async function handleLogout() {
  try {
    clearAppError();
    setAppLoading(true);
    await logoutUser();
  } catch (error) {
    console.error("[Bitácoras App] Error cerrando sesión:", error);
    setAppError(error?.message || "No se pudo cerrar la sesión.");
  } finally {
    if (isCurrentNavigationRequest(navigationRequestId)) {
      setAppLoading(false);
    }
  }
}

function renderInlineError(message) {
  if (!dom.root) return;

  dom.root.innerHTML = `
    <section class="app-error-state" role="alert" aria-live="assertive">
      <div class="app-error-state__card">
        <p class="app-error-state__eyebrow">Ups</p>
        <h1 class="app-error-state__title">Algo falló</h1>
        <p class="app-error-state__text">
          ${escapeHtml(message || CONFIG.text.genericError)}
        </p>
        <div class="app-error-state__actions">
          <button type="button" data-route="${CONFIG.routes.search}">
            Volver a búsqueda
          </button>
          <button type="button" data-action="reload-app">
            Recargar
          </button>
        </div>
      </div>
    </section>
  `;

  appModules.currentUnmount = null;
}

function renderFatalError(error) {
  const target = dom.root || document.body;

  target.innerHTML = `
    <section class="app-fatal-state" role="alert" aria-live="assertive">
      <div class="app-fatal-state__card">
        <p class="app-fatal-state__eyebrow">Error crítico</p>
        <h1 class="app-fatal-state__title">La aplicación no pudo iniciar</h1>
        <p class="app-fatal-state__text">
          ${escapeHtml(
            error?.message || "Ocurrió un error inesperado al iniciar."
          )}
        </p>
        <button type="button" data-action="reload-fatal">
          Intentar de nuevo
        </button>
      </div>
    </section>
  `;

  appModules.currentUnmount = null;
}

function patchAppReady(ready) {
  const state = getState();

  setState({
    ...state,
    app: {
      ...state.app,
      ready: Boolean(ready),
    },
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function logDebug(...args) {
  if (!CONFIG.debug) return;
  console.log("[Bitácoras App]", ...args);
}

export { initApp, navigateTo };



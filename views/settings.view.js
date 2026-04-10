import { CONFIG } from "../config.js";
import { resolveUserAccess } from "../authz.js";
import {
  getState,
  subscribe,
  setAppError,
  clearAppError,
  setAppLoading,
} from "../state.js";
import {
  getCatalogs,
  getEmptyCatalogs,
  saveCatalogs,
} from "../api/catalogs.api.js";
import {
  listStudentAccessUsers,
  syncStudentAccessUsersFromSheet,
} from "../api/users.api.js";
import {
  escapeHtml,
  isPlainObject,
  toStringSafe,
} from "../utils/shared.js";

let viewRoot = null;
let unsubscribeView = null;
let currentSubscribe = null;
let currentNavigateTo = null;
let currentCatalogs = getEmptyCatalogs();
let currentMessage = null;
let currentStudentAccessUsers = [];
let currentStudentSyncReport = null;
const expandedSettingsPanels = new Set();

const STRING_CATALOGS = [
  { key: "categorias", label: "Categorías" },
  { key: "componenteCorporal", label: "Componente corporal" },
  { key: "componenteTecnico", label: "Componente técnico" },
  { key: "componenteTeorico", label: "Componente teórico" },
  { key: "componenteObras", label: "Componente de obras" },
];

export async function beforeEnter() {
  await Promise.all([refreshCatalogs(), refreshStudentAccessUsers()]);
}

export async function render({ root, state, subscribe: subscribeFn, navigateTo }) {
  viewRoot = root;
  currentSubscribe = typeof subscribeFn === "function" ? subscribeFn : null;
  currentNavigateTo = typeof navigateTo === "function" ? navigateTo : null;

  renderView(state || getState());
  setupSubscription();
}

export function beforeLeave() {
  cleanupView();
}

export function destroy() {
  cleanupView();
}

async function refreshCatalogs() {
  try {
    currentCatalogs = await getCatalogs();
    currentMessage = null;
  } catch (error) {
    currentCatalogs = getEmptyCatalogs();
    currentMessage = {
      type: "warning",
      text:
        error?.code === "CATALOGS_NOT_FOUND"
          ? "Todavía no existe el documento de catálogos en Firestore. Puedes crearlo desde esta vista guardando por primera vez."
          : error?.message || "No se pudieron cargar los catálogos.",
    };
  }
}

async function refreshStudentAccessUsers() {
  try {
    currentStudentAccessUsers = await listStudentAccessUsers();
  } catch (error) {
    currentStudentAccessUsers = [];
    currentMessage = {
      type: "warning",
      text: error?.message || "No se pudieron cargar los accesos de estudiantes.",
    };
  }
}

function setupSubscription() {
  if (unsubscribeView) {
    unsubscribeView();
    unsubscribeView = null;
  }

  if (typeof currentSubscribe !== "function") return;

  unsubscribeView = currentSubscribe((state) => {
    if (!viewRoot || !viewRoot.isConnected) return;
    renderView(state || getState());
  });
}

function cleanupView() {
  if (unsubscribeView) {
    unsubscribeView();
    unsubscribeView = null;
  }

  viewRoot = null;
  currentSubscribe = null;
  currentNavigateTo = null;
}

function renderView(state) {
  if (!viewRoot) return;

  viewRoot.innerHTML = buildMarkup(state);
  bindEvents(state);
}

function buildMarkup(state) {
  const isAuthenticated = Boolean(state?.auth?.isAuthenticated);
  const access = resolveUserAccess(state?.auth?.user);
  const canManageSettings = access.canManageSettings;
  const teacherCount = Array.isArray(currentCatalogs.docentes)
    ? currentCatalogs.docentes.length
    : 0;
  const studentAccessCount = Array.isArray(currentStudentAccessUsers)
    ? currentStudentAccessUsers.length
    : 0;
  const updatedAt = toStringSafe(currentCatalogs.updatedAt);

  if (!canManageSettings) {
    return `
      <section class="view-shell view-shell--settings">
        <header class="view-header">
          <div class="view-header__content">
            <p class="view-eyebrow">Configuracion</p>
            <h1 class="view-title">Acceso restringido</h1>
            <p class="view-description">
              Esta vista es solo para administracion. Los docentes pueden trabajar desde perfil, busqueda y bitacoras.
            </p>
          </div>
          <div class="view-header__actions">
            <button type="button" class="btn btn--ghost" data-route="${CONFIG.routes.profile}">
              Ir al perfil
            </button>
          </div>
        </header>
      </section>
    `;
  }

  return `
    <section class="view-shell view-shell--settings">
      <header class="view-header">
        <div class="view-header__content">
          <p class="view-eyebrow">Configuración</p>
          <h1 class="view-title">Catálogos del sistema</h1>
          <p class="view-description">
            Administra docentes, categorías y componentes desde la misma app. También puedes importar listas grandes en formato CSV o TSV.
          </p>
        </div>
        <div class="view-header__actions">
          <button type="button" class="btn btn--ghost" data-route="${CONFIG.routes.search}">
            Volver a búsqueda
          </button>
          <button type="button" class="btn btn--secondary" id="settings-refresh-btn">
            Recargar catálogos
          </button>
          <button
            type="button"
            class="btn btn--primary"
            id="settings-save-btn"
            ${!isAuthenticated || !canManageSettings ? "disabled" : ""}
          >
            Guardar en Firebase
          </button>
        </div>
      </header>

      <section class="settings-grid">
        <article class="card settings-summary-card">
          <p class="panel-header__eyebrow">Resumen</p>
          <h2 class="panel-header__title">Estado actual</h2>
          <div class="settings-summary-list">
            <div class="soft-card">
              <strong>${teacherCount}</strong>
              <span>Docentes</span>
            </div>
            <div class="soft-card">
              <strong>${studentAccessCount}</strong>
              <span>Correos de estudiantes</span>
            </div>
            ${STRING_CATALOGS.map(
              ({ key, label }) => `
                <div class="soft-card">
                  <strong>${Array.isArray(currentCatalogs[key]) ? currentCatalogs[key].length : 0}</strong>
                  <span>${escapeHtml(label)}</span>
                </div>
              `
            ).join("")}
          </div>
          ${
            updatedAt
              ? `<p class="field__hint">Última actualización: ${escapeHtml(updatedAt)}</p>`
              : `<p class="field__hint">Aún no hay una versión guardada de estos catálogos.</p>`
          }
          ${
            currentMessage
              ? `<div class="message-box message-box--${escapeHtml(currentMessage.type || "info")}">${escapeHtml(currentMessage.text || "")}</div>`
              : ""
          }
          ${
            !isAuthenticated
              ? `<div class="message-box message-box--warning">Inicia sesión para guardar cambios en Firestore.</div>`
              : ""
          }
        </article>

        <article class="card settings-panel">
          <header class="panel-header">
            <div class="panel-header__content">
              <p class="panel-header__eyebrow">Accesos</p>
              <h2 class="panel-header__title">Correos de estudiantes</h2>
            </div>
          </header>

          <div class="settings-import-row">
            <p class="field__hint">
              Sincroniza los correos de la hoja a Firebase para que el login de estudiantes se resuelva rÃ¡pido y sin depender de buscar toda la base en cada entrada.
            </p>
          </div>

          <div class="settings-form-actions">
            <button
              type="button"
              class="btn btn--secondary"
              id="settings-sync-students-btn"
              ${!isAuthenticated || !canManageSettings ? "disabled" : ""}
            >
              Actualizar correos de estudiantes
            </button>
            <button
              type="button"
              class="btn btn--ghost"
              id="settings-refresh-students-access-btn"
            >
              Recargar lista
            </button>
          </div>

          ${
            currentStudentSyncReport
              ? `
                <div class="message-box message-box--info">
                  Leidos: ${escapeHtml(String(currentStudentSyncReport.totalStudentsRead || 0))} ·
                  validos: ${escapeHtml(String(currentStudentSyncReport.validStudents || 0))} ·
                  nuevos: ${escapeHtml(String(currentStudentSyncReport.created || 0))} ·
                  actualizados: ${escapeHtml(String(currentStudentSyncReport.updated || 0))} ·
                  sin cambios: ${escapeHtml(String(currentStudentSyncReport.unchanged || 0))} ·
                  sin correo: ${escapeHtml(String(currentStudentSyncReport.skippedMissingEmail || 0))} ·
                  duplicados: ${escapeHtml(String(currentStudentSyncReport.skippedDuplicateEmail || 0))} ·
                  conflictos: ${escapeHtml(String(currentStudentSyncReport.conflicts || 0))}
                </div>
              `
              : ""
          }

          ${buildCollapsibleList({
            listKey: "student-access-list",
            title: "Lista sincronizada",
            count: studentAccessCount,
            singular: "registro",
            plural: "registros",
            content: `
              <div class="settings-list" id="settings-student-access-list">
                ${renderStudentAccessList(currentStudentAccessUsers)}
              </div>
            `,
          })}
        </article>

        <article class="card settings-panel">
          <header class="panel-header">
            <div class="panel-header__content">
              <p class="panel-header__eyebrow">Docentes</p>
              <h2 class="panel-header__title">Lista de docentes</h2>
            </div>
          </header>

          <form id="settings-teacher-form" class="settings-form-grid">
            <label class="field">
              <span class="field__label">Nombre</span>
              <input class="field__input" name="nombre" type="text" placeholder="Nombre completo del docente" required />
            </label>
            <label class="field">
              <span class="field__label">Alias</span>
              <input class="field__input" name="alias" type="text" placeholder="Ej: Profe Alek" />
            </label>
            <label class="field">
              <span class="field__label">Email</span>
              <input class="field__input" name="email" type="email" placeholder="correo@musicala.com" />
            </label>
            <label class="field">
              <span class="field__label">Orden</span>
              <input class="field__input" name="orden" type="number" min="1" step="1" placeholder="1" />
            </label>
            <div class="settings-form-actions">
              <button type="submit" class="btn btn--secondary">Agregar docente</button>
            </div>
          </form>

          <div class="settings-import-row">
            <label class="field settings-import-field">
              <span class="field__label">Importar docentes (.csv o .tsv)</span>
              <input type="file" class="field__input" id="settings-import-teachers" accept=".csv,.tsv,text/csv,text/tab-separated-values" />
            </label>
            <p class="field__hint">Si el archivo tiene encabezados, usa las columnas nombre, alias, email, activo y orden. Si no, se toma la primera columna como nombre.</p>
          </div>

          ${buildCollapsibleList({
            listKey: "teachers-list",
            title: "Lista actual",
            count: teacherCount,
            singular: "docente",
            plural: "docentes",
            content: `
              <div class="settings-list" id="settings-teachers-list">
                ${renderTeachersList(currentCatalogs.docentes)}
              </div>
            `,
          })}
        </article>

        ${STRING_CATALOGS.map((catalog) => buildStringCatalogCard(catalog)).join("")}
      </section>
    </section>
  `;
}

function buildCollapsibleList({
  listKey,
  title,
  count,
  singular = "elemento",
  plural = "elementos",
  content,
}) {
  const isExpanded = isSettingsListExpanded(listKey);
  const bodyId = getSettingsListBodyId(listKey);

  return `
    <section
      class="settings-collapsible ${isExpanded ? "is-expanded" : "is-collapsed"}"
      data-settings-list-root="${escapeHtml(listKey)}"
    >
      <button
        type="button"
        class="settings-collapsible__toggle"
        data-settings-list-toggle="${escapeHtml(listKey)}"
        aria-expanded="${isExpanded ? "true" : "false"}"
        aria-controls="${escapeHtml(bodyId)}"
      >
        <span class="settings-collapsible__copy">
          <span class="settings-collapsible__title">${escapeHtml(title)}</span>
          <span class="settings-collapsible__count">${escapeHtml(formatItemCount(count, singular, plural))}</span>
        </span>
        <span class="settings-collapsible__meta">
          <span class="settings-collapsible__action" data-settings-list-action>
            ${isExpanded ? "Ocultar" : "Mostrar"}
          </span>
          <span class="settings-collapsible__icon" data-settings-list-icon aria-hidden="true">
            ${isExpanded ? "-" : "+"}
          </span>
        </span>
      </button>

      <div
        class="settings-collapsible__body ${isExpanded ? "" : "is-hidden"}"
        id="${escapeHtml(bodyId)}"
      >
        ${content}
      </div>
    </section>
  `;
}

function buildStringCatalogCard({ key, label }) {
  const items = Array.isArray(currentCatalogs[key]) ? currentCatalogs[key] : [];

  return `
    <article class="card settings-panel">
      <header class="panel-header">
        <div class="panel-header__content">
          <p class="panel-header__eyebrow">Catálogo</p>
          <h2 class="panel-header__title">${escapeHtml(label)}</h2>
        </div>
      </header>

      <form class="settings-string-form" data-catalog-form="${escapeHtml(key)}">
        <label class="field">
          <span class="field__label">Agregar un ítem</span>
          <input class="field__input" name="item" type="text" placeholder="Escribe un valor y agrégalo a la lista" />
        </label>
        <div class="settings-form-actions">
          <button type="submit" class="btn btn--secondary">Agregar</button>
        </div>
      </form>

      <label class="field">
        <span class="field__label">Pegar varios valores</span>
        <textarea class="field__textarea settings-bulk-textarea" rows="5" data-bulk-textarea="${escapeHtml(key)}" placeholder="Pega una lista, una línea por valor."></textarea>
      </label>

      <div class="settings-form-actions">
        <button type="button" class="btn btn--ghost" data-bulk-add="${escapeHtml(key)}">Agregar lote pegado</button>
      </div>

      <div class="settings-import-row">
        <label class="field settings-import-field">
          <span class="field__label">Importar archivo (.csv o .tsv)</span>
          <input type="file" class="field__input" data-import-catalog="${escapeHtml(key)}" accept=".csv,.tsv,text/csv,text/tab-separated-values" />
        </label>
      </div>

      ${buildCollapsibleList({
        listKey: `${key}-list`,
        title: "Elementos cargados",
        count: items.length,
        singular: "elemento",
        plural: "elementos",
        content: `
          <div class="settings-list settings-list--strings">
            ${renderStringItems(key, items)}
          </div>
        `,
      })}
    </article>
  `;
}

function renderTeachersList(teachers = []) {
  if (!Array.isArray(teachers) || !teachers.length) {
    return `
      <div class="empty-state empty-state--soft">
        <h3 class="empty-state__title">Sin docentes</h3>
        <p class="empty-state__text">Puedes agregar docentes manualmente o importarlos desde un archivo.</p>
      </div>
    `;
  }

  return teachers
    .map(
      (teacher, index) => `
        <article class="settings-item-card">
          <div class="settings-item-card__content">
            <h3>${escapeHtml(teacher.alias || teacher.nombre)}</h3>
            <p>${escapeHtml(teacher.nombre)}</p>
            <small>${escapeHtml(teacher.email || "Sin email")} · Orden ${escapeHtml(String(teacher.orden || index + 1))}</small>
          </div>
          <button type="button" class="btn btn--ghost btn--sm" data-remove-teacher="${escapeHtml(teacher.id || teacher.nombre)}">
            Quitar
          </button>
        </article>
      `
    )
    .join("");
}

function renderStudentAccessList(users = []) {
  if (!Array.isArray(users) || !users.length) {
    return `
      <div class="empty-state empty-state--soft">
        <h3 class="empty-state__title">Sin correos sincronizados</h3>
        <p class="empty-state__text">Usa el botÃ³n de actualizar para traer correos nuevos de estudiantes a Firebase.</p>
      </div>
    `;
  }

  return users
    .map(
      (user, index) => `
        <article class="settings-item-card">
          <div class="settings-item-card__content">
            <h3>${escapeHtml(user.displayName || `Estudiante ${index + 1}`)}</h3>
            <p>${escapeHtml(user.email || "Sin email")}</p>
            <small>${escapeHtml(user.studentId || "Sin studentId")} · ${
              user.active ? "Activo" : "Inactivo"
            }</small>
          </div>
        </article>
      `
    )
    .join("");
}

function renderStringItems(key, items = []) {
  if (!Array.isArray(items) || !items.length) {
    return `
      <div class="empty-state empty-state--soft">
        <p class="empty-state__text">Todavía no hay elementos en este catálogo.</p>
      </div>
    `;
  }

  return items
    .map(
      (item) => `
        <article class="settings-item-card settings-item-card--compact">
          <div class="settings-item-card__content">
            <h3>${escapeHtml(item)}</h3>
          </div>
          <button type="button" class="btn btn--ghost btn--sm" data-remove-item="${escapeHtml(key)}" data-item-value="${escapeHtml(item)}">
            Quitar
          </button>
        </article>
      `
    )
    .join("");
}

function bindEvents(state) {
  viewRoot.querySelectorAll("[data-settings-list-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      toggleSettingsList(button);
    });
  });

  const refreshBtn = viewRoot.querySelector("#settings-refresh-btn");
  const saveBtn = viewRoot.querySelector("#settings-save-btn");
  const syncStudentsBtn = viewRoot.querySelector("#settings-sync-students-btn");
  const refreshStudentAccessBtn = viewRoot.querySelector(
    "#settings-refresh-students-access-btn"
  );
  const teacherForm = viewRoot.querySelector("#settings-teacher-form");
  const teacherImport = viewRoot.querySelector("#settings-import-teachers");

  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      await withLoading(async () => {
        await Promise.all([refreshCatalogs(), refreshStudentAccessUsers()]);
        renderView(getState());
      });
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      const access = resolveUserAccess(getState()?.auth?.user);

      if (!state?.auth?.isAuthenticated) {
        currentMessage = {
          type: "warning",
          text: "Necesitas iniciar sesión para guardar en Firestore.",
        };
        renderView(getState());
        return;
      }

      if (!access.canManageSettings) {
        currentMessage = {
          type: "warning",
          text: "Solo un administrador puede modificar esta configuración.",
        };
        renderView(getState());
        return;
      }

      await withLoading(async () => {
        clearAppError();
        currentCatalogs = await saveCatalogs(currentCatalogs);
        currentMessage = {
          type: "success",
          text: "Los catálogos se guardaron correctamente en Firestore.",
        };
        renderView(getState());
      });
    });
  }

  if (syncStudentsBtn) {
    syncStudentsBtn.addEventListener("click", async () => {
      const access = resolveUserAccess(getState()?.auth?.user);

      if (!state?.auth?.isAuthenticated) {
        currentMessage = {
          type: "warning",
          text: "Necesitas iniciar sesiÃ³n para sincronizar correos.",
        };
        renderView(getState());
        return;
      }

      if (!access.canManageSettings) {
        currentMessage = {
          type: "warning",
          text: "Solo un administrador puede sincronizar accesos de estudiantes.",
        };
        renderView(getState());
        return;
      }

      await withLoading(async () => {
        currentStudentSyncReport = await syncStudentAccessUsersFromSheet();
        await refreshStudentAccessUsers();
        expandedSettingsPanels.add("student-access-list");
        currentMessage = {
          type: "success",
          text: `Sincronizacion completada. Nuevos: ${currentStudentSyncReport.created}, actualizados: ${currentStudentSyncReport.updated}, sin cambios: ${currentStudentSyncReport.unchanged}.`,
        };
        renderView(getState());
      });
    });
  }

  if (refreshStudentAccessBtn) {
    refreshStudentAccessBtn.addEventListener("click", async () => {
      await withLoading(async () => {
        await refreshStudentAccessUsers();
        expandedSettingsPanels.add("student-access-list");
        renderView(getState());
      });
    });
  }

  if (teacherForm) {
    teacherForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = new FormData(teacherForm);
      const nombre = toStringSafe(form.get("nombre"));
      if (!nombre) return;

      const teacher = {
        id: buildCatalogId(nombre),
        nombre,
        alias: toStringSafe(form.get("alias")),
        email: toStringSafe(form.get("email")),
        activo: true,
        orden: Number(form.get("orden")) || currentCatalogs.docentes.length + 1,
      };

      currentCatalogs = {
        ...currentCatalogs,
        docentes: normalizeTeachersList([...(currentCatalogs.docentes || []), teacher]),
      };
      expandedSettingsPanels.add("teachers-list");
      currentMessage = {
        type: "info",
        text: "Docente agregado localmente. Guarda en Firebase para dejarlo persistente.",
      };
      renderView(getState());
    });
  }

  if (teacherImport) {
    teacherImport.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;

      const imported = await parseTeacherFile(file);
      currentCatalogs = {
        ...currentCatalogs,
        docentes: normalizeTeachersList([...(currentCatalogs.docentes || []), ...imported]),
      };
      expandedSettingsPanels.add("teachers-list");
      currentMessage = {
        type: "success",
        text: `Se importaron ${imported.length} docentes al catálogo local.`,
      };
      renderView(getState());
    });
  }

  viewRoot.querySelectorAll("[data-remove-teacher]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.getAttribute("data-remove-teacher");
      currentCatalogs = {
        ...currentCatalogs,
        docentes: normalizeTeachersList(
          (currentCatalogs.docentes || []).filter(
            (teacher) => (teacher.id || teacher.nombre) !== key
          )
        ),
      };
      expandedSettingsPanels.add("teachers-list");
      renderView(getState());
    });
  });

  viewRoot.querySelectorAll("[data-catalog-form]").forEach((formEl) => {
    formEl.addEventListener("submit", (event) => {
      event.preventDefault();
      const key = formEl.getAttribute("data-catalog-form");
      const input = formEl.querySelector('input[name="item"]');
      const value = toStringSafe(input?.value);
      if (!key || !value) return;

      appendCatalogItems(key, [value]);
      expandedSettingsPanels.add(`${key}-list`);
      renderView(getState());
    });
  });

  viewRoot.querySelectorAll("[data-bulk-add]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.getAttribute("data-bulk-add");
      const textarea = viewRoot.querySelector(`[data-bulk-textarea="${key}"]`);
      const values = parseSimpleLines(textarea?.value || "");
      if (!key || !values.length) return;
      appendCatalogItems(key, values);
      expandedSettingsPanels.add(`${key}-list`);
      renderView(getState());
    });
  });

  viewRoot.querySelectorAll("[data-import-catalog]").forEach((input) => {
    input.addEventListener("change", async (event) => {
      const key = input.getAttribute("data-import-catalog");
      const file = event.target.files?.[0];
      if (!key || !file) return;

      const importedValues = await parseStringCatalogFile(key, file);
      appendCatalogItems(key, importedValues);
      expandedSettingsPanels.add(`${key}-list`);
      currentMessage = {
        type: "success",
        text: `Se importaron ${importedValues.length} registros en ${getCatalogLabel(key)}.`,
      };
      renderView(getState());
    });
  });

  viewRoot.querySelectorAll("[data-remove-item]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.getAttribute("data-remove-item");
      const value = button.getAttribute("data-item-value");
      if (!key || !value) return;

      currentCatalogs = {
        ...currentCatalogs,
        [key]: (currentCatalogs[key] || []).filter((item) => item !== value),
      };
      expandedSettingsPanels.add(`${key}-list`);
      renderView(getState());
    });
  });
}

function toggleSettingsList(button) {
  const listKey = button?.getAttribute("data-settings-list-toggle");
  if (!listKey) return;

  const shouldExpand = !expandedSettingsPanels.has(listKey);
  const listRoot = button.closest("[data-settings-list-root]");
  const bodyId = button.getAttribute("aria-controls");
  const body = bodyId ? viewRoot?.querySelector(`#${bodyId}`) : null;
  const action = button.querySelector("[data-settings-list-action]");
  const icon = button.querySelector("[data-settings-list-icon]");

  if (shouldExpand) {
    expandedSettingsPanels.add(listKey);
  } else {
    expandedSettingsPanels.delete(listKey);
  }

  button.setAttribute("aria-expanded", shouldExpand ? "true" : "false");

  if (action) {
    action.textContent = shouldExpand ? "Ocultar" : "Mostrar";
  }

  if (icon) {
    icon.textContent = shouldExpand ? "-" : "+";
  }

  if (listRoot) {
    listRoot.classList.toggle("is-expanded", shouldExpand);
    listRoot.classList.toggle("is-collapsed", !shouldExpand);
  }

  if (body) {
    body.classList.toggle("is-hidden", !shouldExpand);
  }
}

function isSettingsListExpanded(listKey) {
  return expandedSettingsPanels.has(toStringSafe(listKey));
}

function getSettingsListBodyId(listKey) {
  return `settings-list-body-${buildCatalogId(listKey)}`;
}

function formatItemCount(count, singular, plural) {
  const safeCount = Number.isFinite(Number(count)) ? Number(count) : 0;
  return `${safeCount} ${safeCount === 1 ? singular : plural}`;
}

function appendCatalogItems(key, items = []) {
  currentCatalogs = {
    ...currentCatalogs,
    [key]: normalizeStringItems([...(currentCatalogs[key] || []), ...items]),
  };
  currentMessage = {
    type: "info",
    text: `Actualizaste ${getCatalogLabel(key)} localmente. Guarda en Firebase para persistir.`,
  };
}

function normalizeStringItems(items = []) {
  return [...new Set(items.map((item) => toStringSafe(item)).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "es", { sensitivity: "base" })
  );
}

function normalizeTeachersList(items = []) {
  const seen = new Set();

  return items
    .map((item, index) => {
      if (!isPlainObject(item)) return null;

      const nombre = toStringSafe(item.nombre);
      if (!nombre) return null;

      const teacher = {
        id: toStringSafe(item.id) || buildCatalogId(nombre),
        nombre,
        alias: toStringSafe(item.alias),
        email: toStringSafe(item.email),
        activo: item.activo !== false,
        orden: Number(item.orden) || index + 1,
      };

      const key = `${teacher.nombre.toLowerCase()}__${teacher.alias.toLowerCase()}__${teacher.email.toLowerCase()}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return teacher;
    })
    .filter(Boolean)
    .sort((a, b) => {
      const orderDiff = (a.orden || 999999) - (b.orden || 999999);
      if (orderDiff !== 0) return orderDiff;
      return a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" });
    });
}

function buildCatalogId(value) {
  return toStringSafe(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function detectDelimiter(text) {
  const sample = String(text || "").slice(0, 1000);
  return sample.includes("\t") ? "\t" : ",";
}

function splitDelimitedRows(text) {
  const safeText = String(text || "").replace(/\r/g, "").trim();
  if (!safeText) return [];

  const delimiter = detectDelimiter(safeText);

  return safeText
    .split("\n")
    .map((line) => line.split(delimiter).map((cell) => toStringSafe(cell.replace(/^"|"$/g, ""))))
    .filter((row) => row.some(Boolean));
}

function parseSimpleLines(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => toStringSafe(line))
    .filter(Boolean);
}

async function parseTeacherFile(file) {
  const text = await file.text();
  const rows = splitDelimitedRows(text);
  if (!rows.length) return [];

  const headers = rows[0].map((cell) => buildCatalogId(cell));
  const hasHeader = headers.includes("nombre") || headers.includes("alias") || headers.includes("email");
  const bodyRows = hasHeader ? rows.slice(1) : rows;

  return normalizeTeachersList(
    bodyRows.map((row, index) => {
      if (hasHeader) {
        const getValue = (name) => {
          const position = headers.indexOf(name);
          return position === -1 ? "" : toStringSafe(row[position]);
        };

        return {
          id: buildCatalogId(getValue("nombre") || `teacher-${index + 1}`),
          nombre: getValue("nombre"),
          alias: getValue("alias"),
          email: getValue("email"),
          activo: !["0", "false", "no", "inactivo"].includes(buildCatalogId(getValue("activo"))),
          orden: Number(getValue("orden")) || index + 1,
        };
      }

      return {
        id: buildCatalogId(row[0] || `teacher-${index + 1}`),
        nombre: toStringSafe(row[0]),
        alias: toStringSafe(row[1]),
        email: toStringSafe(row[2]),
        activo: true,
        orden: Number(row[3]) || index + 1,
      };
    })
  );
}

async function parseStringCatalogFile(key, file) {
  const text = await file.text();
  const rows = splitDelimitedRows(text);
  if (!rows.length) return [];

  const expectedHeader = buildCatalogId(getCatalogLabel(key));
  const values = rows.flat().map((cell) => toStringSafe(cell));

  return normalizeStringItems(
    values.filter((cell, index) => {
      if (!cell) return false;
      if (index > 0) return true;
      const normalized = buildCatalogId(cell);
      return normalized !== expectedHeader && normalized !== buildCatalogId(key);
    })
  );
}

function getCatalogLabel(key) {
  return STRING_CATALOGS.find((item) => item.key === key)?.label || key;
}

async function withLoading(task) {
  try {
    setAppLoading(true);
    clearAppError();
    await task();
  } catch (error) {
    console.error("Error en configuración:", error);
    setAppError(error?.message || "No se pudo completar la operación.");
    currentMessage = {
      type: "error",
      text: error?.message || "No se pudo completar la operación.",
    };
    renderView(getState());
  } finally {
    setAppLoading(false);
  }
}

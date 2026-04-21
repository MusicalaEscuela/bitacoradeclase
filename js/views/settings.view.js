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
  syncTeacherAccessUsers,
} from "../api/users.api.js";
import { syncStudentsFromSheetToFirestore } from "../api/students.api.js";
import { getStudents } from "../api/students.api.js";
import {
  createBitacora,
  getBitacorasByStudent,
  updateBitacora,
} from "../api/bitacoras.api.js";
import {
  escapeHtml,
  isPlainObject,
  normalizeText,
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
let currentBitacoraImportPlan = null;
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

    const state = getState();
    const access = resolveUserAccess(state?.auth?.user);

    if (state?.auth?.isAuthenticated && access.canManageSettings) {
      await syncTeacherAccessUsers(currentCatalogs.docentes || []);
    }

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
            Administra docentes, categorias, componentes y accesos desde una
            vista mas clara para mantenimiento del sistema.
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
              Sincronizar estudiantes a Firebase
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
              <p class="panel-header__eyebrow">Bitácoras</p>
              <h2 class="panel-header__title">Importar histórico desde CSV/TSV</h2>
            </div>
          </header>

          <div class="settings-import-row">
            <label class="field settings-import-field">
              <span class="field__label">Archivo de bitácoras (.csv o .tsv)</span>
              <input type="file" class="field__input" id="settings-import-bitacoras" accept=".csv,.tsv,text/csv,text/tab-separated-values" multiple />
            </label>
            <p class="field__hint">
              Se usan columnas por encabezado o por posición (A-J): fecha, docente, estudiante, tareas/observaciones, categorías y componentes.
              Las columnas extra se ignoran automáticamente.
            </p>
          </div>

          <div class="settings-form-actions">
            <button
              type="button"
              class="btn btn--secondary"
              id="settings-import-bitacoras-btn"
              ${!isAuthenticated || !canManageSettings ? "disabled" : ""}
            >
              Importar bitácoras a Firebase
            </button>
          </div>

          ${renderBitacoraImportSummary()}
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

function renderBitacoraImportSummary() {
  if (!currentBitacoraImportPlan) {
    return `
      <div class="empty-state empty-state--soft">
        <p class="empty-state__text">Selecciona un archivo para previsualizar antes de importar.</p>
      </div>
    `;
  }

  const summary = currentBitacoraImportPlan.summary || {};
  const unresolved = Array.isArray(summary.unresolvedStudents)
    ? summary.unresolvedStudents
    : [];
  const unresolvedPreview = unresolved
    .slice(0, 5)
    .map((name) => `<li>${escapeHtml(name)}</li>`)
    .join("");
  const unresolvedExtra = unresolved.length > 5 ? unresolved.length - 5 : 0;

  return `
    <div class="message-box message-box--info">
      Archivo leído: ${escapeHtml(String(summary.totalRows || 0))} filas ·
      válidas: ${escapeHtml(String(summary.validRows || 0))} ·
      omitidas: ${escapeHtml(String(summary.skippedRows || 0))} ·
      sin estudiante asociado: ${escapeHtml(String(unresolved.length))}
    </div>
    ${
      unresolved.length
        ? `
          <div class="settings-list settings-list--strings">
            <article class="settings-item-card settings-item-card--compact">
              <div class="settings-item-card__content">
                <h3>Estudiantes sin coincidencia automática</h3>
                <small>Revisa estos nombres en tu CSV o en el catálogo de estudiantes.</small>
                <ul>
                  ${unresolvedPreview}
                </ul>
                ${
                  unresolvedExtra > 0
                    ? `<small>Y ${escapeHtml(String(unresolvedExtra))} más...</small>`
                    : ""
                }
              </div>
            </article>
          </div>
        `
        : ""
    }
  `;
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
  const bitacoraImportInput = viewRoot.querySelector("#settings-import-bitacoras");
  const bitacoraImportBtn = viewRoot.querySelector("#settings-import-bitacoras-btn");

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
        currentStudentSyncReport = await syncStudentsFromSheetToFirestore();
        await syncStudentAccessUsersFromSheet();
        await refreshStudentAccessUsers();
        expandedSettingsPanels.add("student-access-list");
        currentMessage = {
          type: "success",
          text: `Sincronizacion completada. Estudiantes nuevos: ${currentStudentSyncReport.created}, actualizados: ${currentStudentSyncReport.updated}, sin cambios: ${currentStudentSyncReport.unchanged}.`,
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

  if (bitacoraImportInput) {
    bitacoraImportInput.addEventListener("change", async (event) => {
      const files = Array.from(event.target.files || []).filter(Boolean);
      if (!files.length) return;

      await withLoading(async () => {
        currentBitacoraImportPlan = await buildBitacoraImportPlanFromFiles(files);
        currentMessage = {
          type: "success",
          text: `Archivos preparados (${currentBitacoraImportPlan.summary.sourceFiles || files.length}). Registros listos para importar: ${currentBitacoraImportPlan.summary.validRows}.`,
        };
        renderView(getState());
      });
    });
  }

  if (bitacoraImportBtn) {
    bitacoraImportBtn.addEventListener("click", async () => {
      const access = resolveUserAccess(getState()?.auth?.user);

      if (!state?.auth?.isAuthenticated) {
        currentMessage = {
          type: "warning",
          text: "Necesitas iniciar sesión para importar bitácoras.",
        };
        renderView(getState());
        return;
      }

      if (!access.canManageSettings) {
        currentMessage = {
          type: "warning",
          text: "Solo un administrador puede importar bitácoras históricas.",
        };
        renderView(getState());
        return;
      }

      if (!currentBitacoraImportPlan?.items?.length) {
        currentMessage = {
          type: "warning",
          text: "No hay registros listos. Primero selecciona un CSV/TSV válido.",
        };
        renderView(getState());
        return;
      }

      await withLoading(async () => {
        const result = await importBitacoraPlan(currentBitacoraImportPlan);
        currentMessage = {
          type: "success",
          text: `Importación completada. Creadas: ${result.created}, actualizadas: ${result.updated}, duplicadas omitidas: ${result.deduped}, fallidas: ${result.failed}.`,
        };
        renderView(getState());
      });
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
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < safeText.length; index += 1) {
    const char = safeText[index];
    const nextChar = safeText[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      row.push(toStringSafe(cell));
      cell = "";
      continue;
    }

    if (char === "\n" && !inQuotes) {
      row.push(toStringSafe(cell));
      if (row.some(Boolean)) {
        rows.push(row);
      }
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(toStringSafe(cell));
  if (row.some(Boolean)) {
    rows.push(row);
  }

  return rows;
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

function normalizeHeaderName(value) {
  return buildCatalogId(value).replace(/[^a-z0-9]/g, "");
}

function normalizeCellList(value) {
  return String(value || "")
    .split(/,|;|\n/g)
    .map((item) => toStringSafe(item))
    .filter(Boolean);
}

function parseFlexibleDate(value) {
  const raw = toStringSafe(value);
  if (!raw) return "";

  // Prioridad: formato local del archivo (dd/mm/yyyy o dd-mm-yyyy),
  // con o sin hora, para evitar inversiones mes/día.
  const dmyMatch = raw.match(
    /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (dmyMatch) {
    const day = Number(dmyMatch[1]);
    const month = Number(dmyMatch[2]);
    const year = Number(dmyMatch[3].length === 2 ? `20${dmyMatch[3]}` : dmyMatch[3]);
    const hours = Number(dmyMatch[4] || 0);
    const minutes = Number(dmyMatch[5] || 0);
    const seconds = Number(dmyMatch[6] || 0);
    const parsed = new Date(year, month - 1, day, hours, minutes, seconds);

    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }

  // Soporte secundario para yyyy-mm-dd o strings ISO.
  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) {
    return direct.toISOString().slice(0, 10);
  }

  return raw;
}

function extractStudentName(rawStudent) {
  const safe = toStringSafe(rawStudent);
  if (!safe) return "";

  if (safe.includes(" - ")) {
    return toStringSafe(safe.split(" - ")[0]);
  }

  return safe;
}

function extractStudentProcessHint(rawStudent) {
  const safe = toStringSafe(rawStudent);
  if (!safe || !safe.includes(" - ")) return "";
  const parts = safe.split(" - ").map((part) => toStringSafe(part)).filter(Boolean);
  if (parts.length < 2) return "";
  return parts.slice(1).join(" - ");
}

function splitStudentEntries(rawStudent) {
  const safe = toStringSafe(rawStudent);
  if (!safe) return [];

  return safe
    .split(",")
    .map((entry) => toStringSafe(entry))
    .filter(Boolean);
}

function extractStudentNames(rawStudent) {
  const entries = splitStudentEntries(rawStudent);
  const names = entries.map((entry) => extractStudentName(entry)).filter(Boolean);
  return [...new Set(names)];
}
function resolveImportedProcess(student, parsedRow = {}) {
  // Importaci�n replanteada: no auto-categorizar por proceso.
  // La asignaci�n queda manual desde el front.
  return {
    processKey: "",
    processLabel: "",
    area: "",
    modalidad: "",
    docente: toStringSafe(parsedRow?.docente || student?.docente),
    sede: "",
    programa: "",
  };
}

function mapBitacoraRow(row, headerIndex) {
  const getByIndex = (index) => toStringSafe(row[index]);
  const getByHeader = (...aliases) => {
    for (const alias of aliases) {
      const position = headerIndex[alias];
      if (Number.isInteger(position)) {
        const value = toStringSafe(row[position]);
        if (value) return value;
      }
    }
    return "";
  };

  const fechaClase =
    getByHeader("fecha", "fechaclase", "date") || getByIndex(0);
  const docente =
    getByHeader("docente", "teacher", "profesor") || getByIndex(1);
  const estudianteRaw =
    getByHeader("estudiante", "alumno", "student", "nombreestudiante") ||
    getByIndex(2);
  const content =
    getByHeader(
      "tareasobservaciones",
      "tareas",
      "observaciones",
      "contenido",
      "content",
      "apuntes"
    ) || getByIndex(3);
  const tagsRaw =
    getByHeader("categorias", "categoria", "tags", "etiquetas") || getByIndex(4);
  const componenteCorporal =
    getByHeader("componentecorporal", "corporal") || getByIndex(5);
  const componenteTecnico =
    getByHeader("componentetecnico", "tecnico") || getByIndex(6);
  const componenteTeorico =
    getByHeader("componenteteorico", "teorico") || getByIndex(7);
  const componenteObras =
    getByHeader("componentedeobras", "componenteobras", "obras") || getByIndex(8);
  const componenteComplementario =
    getByHeader("componentecomplementario", "complementario") || getByIndex(9);

  return {
    fechaClase: parseFlexibleDate(fechaClase),
    docente,
    estudianteRaw,
    estudianteNombres: extractStudentNames(estudianteRaw),
    estudianteProcesoHint: extractStudentProcessHint(estudianteRaw),
    content,
    tags: normalizeCellList(tagsRaw),
    componenteCorporal: normalizeCellList(componenteCorporal),
    componenteTecnico: normalizeCellList(componenteTecnico),
    componenteTeorico: normalizeCellList(componenteTeorico),
    componenteObras: normalizeCellList(componenteObras),
    componenteComplementario: normalizeCellList(componenteComplementario),
  };
}

function buildStudentNameIndex(students = []) {
  const index = new Map();

  students.forEach((student) => {
    const id = toStringSafe(student?.studentKey || student?.id || student?.studentId);
    const name = toStringSafe(student?.nombre || student?.name || student?.estudiante);
    if (!id || !name) return;

    const normalized = normalizeText(name);
    if (!normalized) return;

    if (!index.has(normalized)) {
      index.set(normalized, student);
    }
  });

  return index;
}

function createBitacoraPayloadFromRow(parsedRow, students = []) {
  const linkedStudents = (Array.isArray(students) ? students : [])
    .map((student) => {
      const id = toStringSafe(student?.studentKey || student?.id || student?.studentId);
      const name = toStringSafe(student?.nombre || student?.name || student?.estudiante);
      return id ? { id, name: name || id, source: student } : null;
    })
    .filter(Boolean);

  if (!linkedStudents.length) {
    return null;
  }

  const primary = linkedStudents[0];
  const content = toStringSafe(parsedRow.content);
  const process = resolveImportedProcess(primary.source, parsedRow);
  const isGroup = linkedStudents.length > 1;
  const studentIds = linkedStudents.map((item) => item.id);
  const studentRefs = linkedStudents.map((item) => ({ id: item.id, name: item.name }));
  const studentOverrides = {};

  linkedStudents.forEach((item) => {
    studentOverrides[item.id] = {
      enabled: true,
      tareas: content,
      etiquetas: parsedRow.componenteComplementario,
      componenteCorporal: parsedRow.componenteCorporal,
      componenteTecnico: parsedRow.componenteTecnico,
      componenteTeorico: parsedRow.componenteTeorico,
      componenteObras: parsedRow.componenteObras,
    };
  });

  const titleBase = isGroup
    ? `Bit�cora grupal (${linkedStudents.length})`
    : `Bit�cora ${primary.name}`;

  return {
    mode: isGroup ? CONFIG.modes.group : CONFIG.modes.individual,
    studentId: primary.id,
    studentKey: primary.id,
    studentIds,
    studentRefs,
    primaryStudentId: primary.id,
    title: `${titleBase}${parsedRow.fechaClase ? ` - ${parsedRow.fechaClase}` : ""}`,
    content,
    fechaClase: parsedRow.fechaClase || "",
    tags: parsedRow.tags,
    studentOverrides,
    process: {
      processKey: process.processKey,
      processLabel: process.processLabel,
      area: process.area,
      modalidad: process.modalidad,
      docente: process.docente,
      sede: process.sede,
      programa: process.programa,
    },
    source: "csv_import",
    metadata: {
      importSource: "settings_csv",
      importedAt: new Date().toISOString(),
      importedAsGroup: isGroup,
      importedStudentCount: linkedStudents.length,
    },
  };
}

function normalizeFingerprintText(value) {
  return normalizeText(value || "").replace(/\s+/g, " ").trim();
}

function normalizeListForFingerprint(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalizeFingerprintText).filter(Boolean))].sort();
}

function buildFingerprintFromPayload(payload = {}) {
  const overrides = payload?.studentOverrides || {};
  const firstOverride = Object.values(overrides)[0] || {};
  const studentId = toStringSafe(payload?.primaryStudentId || payload?.studentId || payload?.studentIds?.[0]);
  const studentIds = normalizeListForFingerprint(payload?.studentIds || [studentId]);
  const docente = toStringSafe(payload?.process?.docente);
  const content = toStringSafe(payload?.content);
  const tags = normalizeListForFingerprint(payload?.tags);
  const componentes = normalizeListForFingerprint([
    ...(firstOverride?.componenteCorporal || []),
    ...(firstOverride?.componenteTecnico || []),
    ...(firstOverride?.componenteTeorico || []),
    ...(firstOverride?.componenteObras || []),
    ...(firstOverride?.etiquetas || []),
  ]);

  return JSON.stringify({
    studentId: normalizeFingerprintText(studentId),
    studentIds,
    docente: normalizeFingerprintText(docente),
    content: normalizeFingerprintText(content),
    tags,
    componentes,
  });
}

function buildFingerprintFromExisting(item = {}) {
  const overrides = item?.studentOverrides || {};
  const firstOverride = Object.values(overrides)[0] || {};
  const studentId = toStringSafe(item?.primaryStudentId || item?.studentId || item?.studentIds?.[0]);
  const studentIds = normalizeListForFingerprint(item?.studentIds || [studentId]);
  const docente = toStringSafe(item?.process?.docente);
  const content = toStringSafe(item?.content || item?.contenido);
  const tags = normalizeListForFingerprint(item?.tags || item?.etiquetas);
  const componentes = normalizeListForFingerprint([
    ...(firstOverride?.componenteCorporal || []),
    ...(firstOverride?.componenteTecnico || []),
    ...(firstOverride?.componenteTeorico || []),
    ...(firstOverride?.componenteObras || []),
    ...(firstOverride?.etiquetas || []),
  ]);

  return JSON.stringify({
    studentId: normalizeFingerprintText(studentId),
    studentIds,
    docente: normalizeFingerprintText(docente),
    content: normalizeFingerprintText(content),
    tags,
    componentes,
  });
}

async function buildBitacoraImportPlan(file, options = {}) {
  const text = await file.text();
  const rows = splitDelimitedRows(text);
  if (!rows.length) {
    return {
      items: [],
      summary: {
        totalRows: 0,
        validRows: 0,
        skippedRows: 0,
        unresolvedStudents: [],
      },
    };
  }

  const headers = rows[0].map((cell) => normalizeHeaderName(cell));
  const hasHeader =
    headers.includes("fecha") ||
    headers.includes("estudiante") ||
    headers.includes("tareasobservaciones") ||
    headers.includes("categorias");
  const bodyRows = hasHeader ? rows.slice(1) : rows;
  const headerIndex = {};

  headers.forEach((name, index) => {
    if (name && headerIndex[name] === undefined) {
      headerIndex[name] = index;
    }
  });

  const students = Array.isArray(options.students)
    ? options.students
    : await getStudents({ includeInactive: true, estado: "todos" });
  const studentByName = buildStudentNameIndex(students);
  const unresolvedStudents = [];
  const items = [];

  bodyRows.forEach((row) => {
    const parsed = mapBitacoraRow(row, hasHeader ? headerIndex : {});
    const content = toStringSafe(parsed.content);
    const studentNames = Array.isArray(parsed.estudianteNombres)
      ? parsed.estudianteNombres
      : [];

    if (!content || !studentNames.length) {
      return;
    }

    const matchedStudents = [];

    studentNames.forEach((name) => {
      const normalizedName = normalizeText(name);
      if (!normalizedName) return;

      const matchedStudent = studentByName.get(normalizedName);
      if (!matchedStudent) {
        unresolvedStudents.push(name);
        return;
      }

      matchedStudents.push(matchedStudent);
    });

    const dedupedMatchedStudents = [];
    const seenIds = new Set();

    matchedStudents.forEach((student) => {
      const id = toStringSafe(student?.studentKey || student?.id || student?.studentId);
      if (!id || seenIds.has(id)) return;
      seenIds.add(id);
      dedupedMatchedStudents.push(student);
    });

    if (!dedupedMatchedStudents.length) {
      return;
    }

    const payload = createBitacoraPayloadFromRow(parsed, dedupedMatchedStudents);
    if (payload) {
      items.push(payload);
    }
  });

  return {
    items,
    summary: {
      totalRows: bodyRows.length,
      validRows: items.length,
      skippedRows: Math.max(bodyRows.length - items.length, 0),
      unresolvedStudents: [...new Set(unresolvedStudents)],
      sourceFiles: 1,
    },
  };
}

async function buildBitacoraImportPlanFromFiles(files = []) {
  const safeFiles = (Array.isArray(files) ? files : []).filter(Boolean);

  if (!safeFiles.length) {
    return {
      items: [],
      summary: {
        totalRows: 0,
        validRows: 0,
        skippedRows: 0,
        unresolvedStudents: [],
        sourceFiles: 0,
      },
    };
  }

  const students = await getStudents({ includeInactive: true, estado: "todos" });
  const mergedItems = [];
  const unresolved = [];
  let totalRows = 0;
  let validRows = 0;
  let skippedRows = 0;

  for (const file of safeFiles) {
    const plan = await buildBitacoraImportPlan(file, { students });
    const summary = plan?.summary || {};

    mergedItems.push(...(Array.isArray(plan?.items) ? plan.items : []));
    unresolved.push(...(Array.isArray(summary.unresolvedStudents) ? summary.unresolvedStudents : []));
    totalRows += Number(summary.totalRows || 0);
    validRows += Number(summary.validRows || 0);
    skippedRows += Number(summary.skippedRows || 0);
  }

  return {
    items: mergedItems,
    summary: {
      totalRows,
      validRows,
      skippedRows,
      unresolvedStudents: [...new Set(unresolved)],
      sourceFiles: safeFiles.length,
    },
  };
}

async function importBitacoraPlan(plan) {
  const items = Array.isArray(plan?.items) ? plan.items : [];
  if (!items.length) {
    return { created: 0, updated: 0, failed: 0, deduped: 0 };
  }

  let created = 0;
  let updated = 0;
  let failed = 0;
  let deduped = 0;

  const studentIds = [...new Set(items.flatMap((item) => item?.studentIds || [item?.primaryStudentId]).map((value) => toStringSafe(value)).filter(Boolean))];
  const existingByFingerprint = new Map();

  for (const studentId of studentIds) {
    try {
      const existing = await getBitacorasByStudent(studentId, { limit: 5000 });
      (Array.isArray(existing) ? existing : []).forEach((entry) => {
        const fingerprint = buildFingerprintFromExisting(entry);
        if (!fingerprint || !entry?.id || existingByFingerprint.has(fingerprint)) return;
        existingByFingerprint.set(fingerprint, entry);
      });
    } catch (error) {
      console.warn("No se pudo cargar historial para deduplicar bitácoras:", studentId, error);
    }
  }

  const importedFingerprints = new Set();

  for (const payload of items) {
    try {
      const fingerprint = buildFingerprintFromPayload(payload);
      if (fingerprint && importedFingerprints.has(fingerprint)) {
        deduped += 1;
        continue;
      }
      if (fingerprint) {
        importedFingerprints.add(fingerprint);
      }

      const existing = fingerprint ? existingByFingerprint.get(fingerprint) : null;

      if (existing?.id) {
        await updateBitacora(existing.id, payload);
        updated += 1;
      } else {
        const createdItem = await createBitacora(payload);
        created += 1;
        if (fingerprint && createdItem?.id) {
          existingByFingerprint.set(fingerprint, createdItem);
        }
      }
    } catch (error) {
      failed += 1;
      console.warn("No se pudo importar una bitácora:", error);
    }
  }

  return { created, updated, failed, deduped };
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














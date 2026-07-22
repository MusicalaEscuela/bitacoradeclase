// js/views/planeador.view.js

/**
 * Planeador Docente Musicala.
 *
 * Vista única con sub-pestañas:
 *  - "Planeaciones": lista + filtros (vista coordinación), formulario y detalle.
 *  - "Tablero": post-its tipo kanban para organizar ideas antes de planear.
 *
 * Reutiliza los catálogos de `app_config/catalogos` (los mismos de las
 * bitácoras) para sugerir subcategorías y ejercicios por componente.
 *
 * Patrón de render: imperativo. Cada interacción que cambia la estructura
 * primero "cosecha" (harvestForm) los valores actuales del DOM hacia el draft
 * para no perder lo escrito, y luego re-renderiza.
 */

import { CONFIG } from "../config.js";
import { resolveUserAccess } from "../authz.js";
import { getState } from "../state.js";
import {
  showSuccess,
  showError,
  showInfo,
  showLoadingToast,
  resolveLoadingToast,
} from "../ui/alerts.ui.js";
import {
  escapeHtml,
  toStringSafe,
  toArraySafe,
  getTodayDate,
  formatDisplayDate,
} from "../utils/shared.js";

import {
  listPlaneaciones,
  getPlaneacion,
  createPlaneacion,
  updatePlaneacion,
  duplicatePlaneacion,
  deletePlaneacion,
  addComentarioCoordinacion,
  listPostits,
  createPostit,
  updatePostit,
  deletePostit,
  loadCatalogsForPlaneador,
  buildAreaCatalog,
  getCatalogTeachers,
} from "../api/planeador.api.js";
import { getTeacherListStudents } from "../api/students.api.js";
import { getBitacorasByStudentIds } from "../api/bitacoras.api.js";

import {
  ARTES,
  COMPONENTES_BITACORA,
  TIPOS_CLASE,
  MOMENTOS,
  NIVELES_GRUPO,
  MATERIALES_SUGERIDOS,
  ESTADOS_PLANEACION,
  ESTADO_LABELS,
  ESTADO_COLORS,
  POSTIT_COLUMNAS,
  POSTIT_COLORES,
  POSTIT_ESTADOS,
  PLANTILLAS,
  OBJETIVO_PLANTILLA,
  OBJETIVO_EJEMPLOS,
  createEmptyPlaneacion,
  createEmptyPostit,
} from "../utils/planeador.constants.js";

/* ==========================================================================
   ESTADO DEL MÓDULO
   ========================================================================== */

let viewRoot = null;
let currentNavigateTo = null;

const pState = {
  tab: "planeaciones", // planeaciones | tablero
  mode: "list", // list | form | detail
  loading: false,
  planeaciones: [],
  postits: [],
  students: [],
  participantHistory: {},
  draft: null,
  draftId: null,
  detailId: null,
  filters: {
    query: "",
    docente: "",
    sede: "",
    grupo: "",
    arte: "",
    estado: "",
    tipoClase: "",
  },
};

/* ==========================================================================
   CICLO DE VIDA
   ========================================================================== */

export async function render({ root, navigateTo }) {
  viewRoot = root;
  currentNavigateTo = typeof navigateTo === "function" ? navigateTo : null;

  const access = resolveUserAccess(getState()?.auth?.user);
  if (access.role !== CONFIG.roles.admin && access.role !== CONFIG.roles.teacher) {
    viewRoot.innerHTML = `
      <section class="view-shell">
        <header class="view-header">
          <div class="view-header__content">
            <p class="view-eyebrow">Planeador</p>
            <h1 class="view-title">Acceso restringido</h1>
            <p class="view-description">El planeador es solo para docentes y administración.</p>
          </div>
        </header>
      </section>`;
    return;
  }

  renderLoading();
  await loadData();
  renderActive();
}

export function destroy() {
  viewRoot = null;
  currentNavigateTo = null;
}

function currentUser() {
  return getState()?.auth?.user || null;
}

function isAdminUser() {
  return resolveUserAccess(currentUser()).role === CONFIG.roles.admin;
}

// Email para filtrar por dueño: vacío si es admin (ve todo).
function ownerScope() {
  if (isAdminUser()) return "";
  return toStringSafe(currentUser()?.email).toLowerCase();
}

async function loadData() {
  pState.loading = true;
  try {
    await loadCatalogsForPlaneador();
    const owner = ownerScope();
    const [planeaciones, postits, students] = await Promise.all([
      listPlaneaciones(owner),
      listPostits(owner),
      getTeacherListStudents().catch((error) => {
        console.warn("[Planeador] No se pudo cargar el listado de estudiantes:", error);
        return [];
      }),
    ]);
    pState.planeaciones = planeaciones;
    pState.postits = postits;
    pState.students = students;
  } catch (error) {
    console.error("[Planeador] Error cargando datos:", error);
    showError(error?.message || "No se pudieron cargar las planeaciones.");
  } finally {
    pState.loading = false;
  }
}

/* ==========================================================================
   RENDER PRINCIPAL
   ========================================================================== */

function renderLoading() {
  if (!viewRoot) return;
  viewRoot.innerHTML = `
    <section class="view-shell">
      <div class="loading-state"><p class="loading-state__text">Cargando planeador...</p></div>
    </section>`;
}

function renderActive() {
  if (!viewRoot) return;

  const content =
    pState.tab === "tablero"
      ? renderBoard()
      : pState.mode === "form"
      ? renderForm()
      : pState.mode === "detail"
      ? renderDetail()
      : renderList();

  viewRoot.innerHTML = `
    <section class="view-shell planeador">
      <header class="view-header">
        <div class="view-header__content">
          <p class="view-eyebrow">Planeador docente · Musicala</p>
          <h1 class="view-title">Planea tu clase con intención</h1>
          <p class="view-description">
            Organiza objetivo, momentos, materiales y evidencia. Guarda en la nube,
            duplica, comparte por WhatsApp y deja claridad a coordinación.
          </p>
        </div>
      </header>

      <div class="planeador-tabs" role="tablist">
        <button type="button" class="planeador-tab ${pState.tab === "planeaciones" ? "is-active" : ""}" data-tab="planeaciones">
          📋 Planeaciones <span class="planeador-tab__badge">${pState.planeaciones.length}</span>
        </button>
        <button type="button" class="planeador-tab ${pState.tab === "tablero" ? "is-active" : ""}" data-tab="tablero">
          🗂️ Tablero <span class="planeador-tab__badge">${pState.postits.length}</span>
        </button>
      </div>

      <div data-planeador-content>${content}</div>
    </section>`;

  bindEvents();
}

/* ==========================================================================
   LISTA + FILTROS (vista coordinación)
   ========================================================================== */

function getFilteredPlaneaciones() {
  const f = pState.filters;
  return pState.planeaciones
    .filter((p) => !p.archived || f.estado === "archivada")
    .filter((p) => {
      if (f.query) {
        const hay = `${p.searchText || ""} ${p.objetivo || ""}`.toLowerCase();
        if (!hay.includes(f.query.toLowerCase())) return false;
      }
      if (f.docente && p.docenteNombre !== f.docente) return false;
      if (f.sede && p.sede !== f.sede) return false;
      if (f.grupo && p.grupoNombre !== f.grupo) return false;
      if (f.arte && p.arte !== f.arte) return false;
      if (f.estado && p.estado !== f.estado) return false;
      if (f.tipoClase && p.tipoClase !== f.tipoClase) return false;
      return true;
    });
}

function uniqueValues(field) {
  return [...new Set(pState.planeaciones.map((p) => toStringSafe(p[field])).filter(Boolean))].sort();
}

function renderList() {
  const items = getFilteredPlaneaciones();

  const filterSelect = (key, label, values) => `
    <select data-filter="${key}">
      <option value="">${label}</option>
      ${values.map((v) => `<option value="${escapeHtml(v)}" ${pState.filters[key] === v ? "selected" : ""}>${escapeHtml(v)}</option>`).join("")}
    </select>`;

  const toolbar = `
    <div class="planeador-toolbar">
      <div class="planeador-filters">
        <input type="search" data-filter="query" placeholder="🔎 Buscar..." value="${escapeHtml(pState.filters.query)}" />
        ${filterSelect("docente", "Docente", uniqueValues("docenteNombre"))}
        ${filterSelect("sede", "Sede", uniqueValues("sede"))}
        ${filterSelect("grupo", "Grupo", uniqueValues("grupoNombre"))}
        <select data-filter="arte">
          <option value="">Área artística</option>
          ${ARTES.map((a) => `<option value="${a.value}" ${pState.filters.arte === a.value ? "selected" : ""}>${escapeHtml(a.label)}</option>`).join("")}
        </select>
        <select data-filter="estado">
          <option value="">Estado</option>
          ${ESTADOS_PLANEACION.map((e) => `<option value="${e.value}" ${pState.filters.estado === e.value ? "selected" : ""}>${e.label}</option>`).join("")}
        </select>
        <select data-filter="tipoClase">
          <option value="">Tipo de clase</option>
          ${TIPOS_CLASE.map((t) => `<option value="${t.value}" ${pState.filters.tipoClase === t.value ? "selected" : ""}>${t.label}</option>`).join("")}
        </select>
      </div>
      <div class="btn-group">
        <button type="button" class="btn btn--ghost btn--sm" data-action="plantillas">✨ Plantillas</button>
        <button type="button" class="btn btn--primary btn--sm" data-action="nueva">＋ Nueva planeación</button>
      </div>
    </div>`;

  if (!pState.planeaciones.length) {
    return `${toolbar}
      <div class="planeador-empty">
        <div class="planeador-empty__icon">🗓️</div>
        <h3>Aún no hay planeaciones</h3>
        <p>Crea tu primera planeación o empieza desde una plantilla.</p>
        <div class="btn-group" style="justify-content:center;margin-top:1rem">
          <button type="button" class="btn btn--primary" data-action="nueva">Crear planeación</button>
          <button type="button" class="btn btn--ghost" data-action="plantillas">✨ Usar una plantilla</button>
        </div>
      </div>`;
  }

  if (!items.length) {
    return `${toolbar}<div class="planeador-empty"><div class="planeador-empty__icon">🔍</div><p>Ningún resultado con esos filtros.</p></div>`;
  }

  return `${toolbar}<div class="planeacion-grid">${items.map(renderPlaneacionCard).join("")}</div>`;
}

function arteMeta(value) {
  return ARTES.find((c) => c.value === value) || { label: value || "Sin área", icon: "🎨" };
}

function renderPlaneacionCard(p) {
  const comp = arteMeta(p.arte);
  const estadoColor = ESTADO_COLORS[p.estado] || "#94a3b8";
  const tipo = TIPOS_CLASE.find((t) => t.value === p.tipoClase);
  // Etiqueta de dueño: solo visible para admin, para ver de quién es cada una.
  const ownerLabel = toStringSafe(p.docenteNombre) || toStringSafe(p.ownerEmail);
  const ownerChip = isAdminUser() && ownerLabel
    ? `<span class="owner-chip" title="Creada por ${escapeHtml(toStringSafe(p.ownerEmail) || ownerLabel)}">👤 ${escapeHtml(ownerLabel)}</span>`
    : "";
  return `
    <article class="planeacion-card" style="--planeacion-accent:${estadoColor}">
      <div class="planeacion-card__head">
        <span class="planeacion-card__componente"><span class="icon">${comp.icon}</span>${escapeHtml(comp.label)}</span>
        <span class="estado-badge" style="background:${estadoColor}"><span class="estado-badge__dot"></span>${escapeHtml(ESTADO_LABELS[p.estado] || p.estado)}</span>
      </div>
      ${ownerChip}
      <h3 class="planeacion-card__title">${escapeHtml(p.grupoNombre || "Grupo sin nombre")} ${p.esReemplazo ? '<span class="tag-reemplazo">REEMPLAZO</span>' : ""}</h3>
      <div class="planeacion-card__meta">
        <span>📅 ${escapeHtml(formatDisplayDate(p.fechaClase) || "Sin fecha")}</span>
        ${p.docenteNombre ? `<span>🧑‍🏫 ${escapeHtml(p.docenteNombre)}</span>` : ""}
        ${p.sede ? `<span>📍 ${escapeHtml(p.sede)}</span>` : ""}
        ${tipo ? `<span>🏷️ ${escapeHtml(tipo.label)}</span>` : ""}
      </div>
      <p class="planeacion-card__objetivo">${escapeHtml(p.objetivo || "Sin objetivo definido todavía.")}</p>
      <div class="planeacion-card__footer">
        <button type="button" class="btn btn--ghost btn--sm" data-action="ver" data-id="${p.id}">Abrir</button>
        <div class="planeacion-card__actions">
          <button type="button" data-action="editar" data-id="${p.id}" title="Editar">✏️</button>
          <button type="button" data-action="duplicar" data-id="${p.id}" title="Duplicar">📑</button>
          <button type="button" data-action="whatsapp" data-id="${p.id}" title="Compartir por WhatsApp">📲</button>
          <button type="button" data-action="eliminar" data-id="${p.id}" title="Eliminar">🗑️</button>
        </div>
      </div>
    </article>`;
}

/* ==========================================================================
   PLANTILLAS
   ========================================================================== */

function renderPlantillas() {
  return `
    <div class="planeacion-block">
      <div class="planeacion-block__head">
        <span class="planeacion-block__num">✨</span>
        <div>
          <h2 class="planeacion-block__title">Plantillas rápidas</h2>
          <p class="planeacion-block__hint">Empieza desde una base lista. Luego ajustas todo.</p>
        </div>
      </div>
      <div class="plantilla-grid">
        ${PLANTILLAS.map((t) => `
          <button type="button" class="plantilla-card" data-action="usar-plantilla" data-plantilla="${t.id}">
            <div class="plantilla-card__icon">${t.icon}</div>
            <p class="plantilla-card__name">${escapeHtml(t.nombre)}</p>
            <p class="plantilla-card__desc">${escapeHtml(t.descripcion)}</p>
          </button>`).join("")}
      </div>
      <div class="btn-group" style="margin-top:1rem">
        <button type="button" class="btn btn--ghost btn--sm" data-action="cancelar-form">← Volver</button>
        <button type="button" class="btn btn--primary btn--sm" data-action="nueva-blanco">Empezar desde cero</button>
      </div>
    </div>`;
}

/* ==========================================================================
   FORMULARIO DE PLANEACIÓN
   ========================================================================== */

function blockHead(num, title, hint) {
  return `<div class="planeacion-block__head">
    <span class="planeacion-block__num">${num}</span>
    <div><h2 class="planeacion-block__title">${title}</h2>${hint ? `<p class="planeacion-block__hint">${hint}</p>` : ""}</div>
  </div>`;
}

function field(label, inputHtml) {
  return `<div class="field"><label>${label}</label>${inputHtml}</div>`;
}

function renderForm() {
  const d = pState.draft || createEmptyPlaneacion();
  if (pState.showPlantillas) return renderPlantillas();

  const areaCatalog = buildAreaCatalog(d.arte);
  const teachers = getCatalogTeachers();

  const teacherOptions = teachers.length
    ? `<select data-field="docenteNombre">
        <option value="">Selecciona docente</option>
        ${teachers.map((t) => `<option value="${escapeHtml(t.nombre)}" ${d.docenteNombre === t.nombre ? "selected" : ""}>${escapeHtml(t.nombre)}</option>`).join("")}
       </select>`
    : `<input type="text" data-field="docenteNombre" value="${escapeHtml(d.docenteNombre)}" placeholder="Nombre del docente" />`;

  return `
    <form class="planeacion-form" data-planeacion-form novalidate>
      <!-- 1. Datos generales -->
      <section class="planeacion-block">
        ${blockHead(1, "Datos generales", "Lo básico para que coordinación sepa qué, con quién y cuándo.")}
        <div class="field-grid">
          ${field("Fecha de la clase", `<input type="date" data-field="fechaClase" value="${escapeHtml(d.fechaClase)}" />`)}
          ${field("Hora inicio", `<input type="time" data-field="horaInicio" value="${escapeHtml(d.horaInicio)}" />`)}
          ${field("Hora fin", `<input type="time" data-field="horaFin" value="${escapeHtml(d.horaFin)}" />`)}
          ${field("Docente", teacherOptions)}
          ${field("Sede", `<input type="text" data-field="sede" value="${escapeHtml(d.sede)}" placeholder="Sede" />`)}
          ${field("Grupo", `<input type="text" data-field="grupoNombre" value="${escapeHtml(d.grupoNombre)}" placeholder="Nombre del grupo" />`)}
          ${field("Edad o ciclo", `<input type="text" data-field="ciclo" value="${escapeHtml(d.ciclo)}" placeholder="Ej: 7-9 años / Ciclo 1" />`)}
          ${field("Duración", `<input type="text" data-field="duracion" value="${escapeHtml(d.duracion)}" placeholder="Ej: 60 min" />`)}
          ${field("Tipo de clase", `<select data-field="tipoClase">${TIPOS_CLASE.map((t) => `<option value="${t.value}" ${d.tipoClase === t.value ? "selected" : ""}>${t.label}</option>`).join("")}</select>`)}
        </div>
      </section>

      <section class="planeacion-block">
        ${blockHead("1.1", "Estudiantes de la clase", "Conecta la planeación con quienes realmente asistirán. El historial mostrado es una ayuda docente; las observaciones privadas no se copian aquí.")}
        ${renderParticipantesEditor(d)}
      </section>

      <!-- 2. Componente artístico (mismo lenguaje que las bitácoras) -->
      <section class="planeacion-block">
        ${blockHead(2, "Componente artístico", "Elige el área y registra los mismos componentes de las bitácoras: corporal, técnico, teórico y de repertorio.")}
        <div class="componente-picker">
          ${ARTES.map((c) => `
            <button type="button" class="componente-option ${d.arte === c.value ? "is-active" : ""}" data-action="set-arte" data-arte="${c.value}">
              <span class="icon">${c.icon}</span><span>${escapeHtml(c.label)}</span>
            </button>`).join("")}
        </div>

        ${renderMultiCatalogField("categorias", "Categorías", "Escribe o elige una categoría y agrégala...", toArraySafe(d.categorias), areaCatalog.categorias)}

        ${COMPONENTES_BITACORA.map((c) =>
          renderMultiCatalogField(c.key, `${c.icon} ${c.label}`, c.placeholder, toArraySafe(d[c.key]), areaCatalog[c.catalogField])
        ).join("")}

        <p class="chip-hint">${areaCatalog.fromCatalog ? "✓ Listas cargadas desde tus catálogos de Configuración (las mismas de las bitácoras)." : "Aún no hay catálogo cargado para esta área: puedes escribir libremente. Carga las listas en Configuración para que se sugieran solas."}</p>
      </section>

      <!-- 3. Objetivo -->
      <section class="planeacion-block">
        ${blockHead(3, "Objetivo de la clase", escapeHtml(OBJETIVO_PLANTILLA))}
        ${field("", `<textarea data-field="objetivo" placeholder="${escapeHtml(OBJETIVO_PLANTILLA)}">${escapeHtml(d.objetivo)}</textarea>`)}
        <div class="chip-set">
          ${OBJETIVO_EJEMPLOS.map((ej, i) => `<button type="button" class="chip-suggest" data-action="set-objetivo" data-idx="${i}">Ejemplo ${i + 1}</button>`).join("")}
        </div>
      </section>

      <!-- 5. Momentos -->
      <section class="planeacion-block">
        ${blockHead(5, "Momentos de clase", "La columna vertebral de la clase Musicala.")}
        ${MOMENTOS.map((m) => `
          <div class="momento">
            <div class="momento__head"><span class="momento__icon">${m.icon}</span><span class="momento__label">${escapeHtml(m.label)}</span></div>
            <p class="momento__help">${escapeHtml(m.help)}</p>
            <textarea data-field="momento.${m.key}" placeholder="${escapeHtml(m.placeholder)}">${escapeHtml(d.momentosClase?.[m.key] || "")}</textarea>
          </div>`).join("")}
      </section>

      <!-- 6. Adaptaciones -->
      <section class="planeacion-block">
        ${blockHead(6, "Adaptaciones del grupo", "La misma actividad cambia según edad, energía y nivel.")}
        <div class="field-grid">
          ${field("Nivel del grupo", `<select data-field="adapt.nivelGrupo">${[{ value: "", label: "Selecciona" }, ...NIVELES_GRUPO].map((n) => `<option value="${n.value}" ${d.adaptaciones?.nivelGrupo === n.value ? "selected" : ""}>${n.label}</option>`).join("")}</select>`)}
        </div>
        <div class="chip-set" style="margin:0.5rem 0">
          <label class="material-item"><input type="checkbox" data-field="adapt.estudiantesNuevos" ${d.adaptaciones?.estudiantesNuevos ? "checked" : ""}/> Hay estudiantes nuevos</label>
          <label class="material-item"><input type="checkbox" data-field="adapt.grupoMixto" ${d.adaptaciones?.grupoMixto ? "checked" : ""}/> Grupo mixto</label>
        </div>
        ${field("Ajustes o apoyos necesarios (opcional)", `<textarea data-field="adapt.descripcion" placeholder="Escribe aquí únicamente si el grupo requiere algún ajuste.">${escapeHtml(d.adaptaciones?.descripcion || "")}</textarea>`)}
      </section>

      <!-- 7. Materiales -->
      <section class="planeacion-block">
        ${blockHead(7, "Materiales", "Marca lo que necesitas. Agrega los que falten.")}
        <div class="material-list">
          ${MATERIALES_SUGERIDOS.map((mat) => `<label class="material-item"><input type="checkbox" data-material value="${escapeHtml(mat)}" ${toArraySafe(d.materiales).includes(mat) ? "checked" : ""}/> ${escapeHtml(mat)}</label>`).join("")}
        </div>
        ${field("Otros materiales (uno por línea)", `<textarea data-field="materialesExtra" placeholder="Otro material...">${escapeHtml(toArraySafe(d.materiales).filter((m) => !MATERIALES_SUGERIDOS.includes(m)).join("\n"))}</textarea>`)}
      </section>

      <!-- Reemplazo -->
      <section class="planeacion-block ${d.esReemplazo ? "reemplazo-block" : ""}">
        ${blockHead("🔁", "Tipo de clase: ¿es reemplazo?", "Marca si esta clase la dará un reemplazo, para dar continuidad.")}
        <div class="chip-set">
          <button type="button" class="chip-toggle ${!d.esReemplazo ? "is-active" : ""}" data-action="set-reemplazo" data-value="0">Clase normal</button>
          <button type="button" class="chip-toggle ${d.esReemplazo ? "is-active" : ""}" data-action="set-reemplazo" data-value="1">Clase para reemplazo</button>
        </div>
        ${d.esReemplazo ? `
          <div class="field-grid" style="margin-top:1rem">
            ${field("Docente titular", `<input type="text" data-field="reemp.docenteTitular" value="${escapeHtml(d.reemplazo?.docenteTitular || "")}" />`)}
            ${field("Docente reemplazante", `<input type="text" data-field="reemp.docenteReemplazante" value="${escapeHtml(d.reemplazo?.docenteReemplazante || "")}" />`)}
          </div>
          ${field("¿Qué debe continuar?", `<textarea data-field="reemp.continuidad">${escapeHtml(d.reemplazo?.continuidad || "")}</textarea>`)}
          ${field("¿Qué NO debe cambiar?", `<textarea data-field="reemp.noCambiar">${escapeHtml(d.reemplazo?.noCambiar || "")}</textarea>`)}
          ${field("Indicaciones importantes del grupo", `<textarea data-field="reemp.indicacionesGrupo">${escapeHtml(d.reemplazo?.indicacionesGrupo || "")}</textarea>`)}
          ${field("Material previo", `<textarea data-field="reemp.materialPrevio">${escapeHtml(d.reemplazo?.materialPrevio || "")}</textarea>`)}
          ${field("Nivel real del grupo", `<input type="text" data-field="reemp.nivelReal" value="${escapeHtml(d.reemplazo?.nivelReal || "")}" />`)}
          ${field("Alertas de comportamiento o cuidado", `<textarea data-field="reemp.alertas">${escapeHtml(d.reemplazo?.alertas || "")}</textarea>`)}
          ${field("Evidencia que debe entregar el reemplazo", `<textarea data-field="reemp.evidenciaSolicitada">${escapeHtml(d.reemplazo?.evidenciaSolicitada || "")}</textarea>`)}
        ` : ""}
      </section>

      <!-- Estado + acciones -->
      <section class="planeacion-block">
        ${blockHead("✅", "Estado de la planeación", "")}
        ${field("Estado", `<select data-field="estado">${ESTADOS_PLANEACION.map((e) => `<option value="${e.value}" ${d.estado === e.value ? "selected" : ""}>${e.label}</option>`).join("")}</select>`)}
      </section>

      <div class="btn-group" style="position:sticky;bottom:0;background:var(--bg-app);padding:0.75rem 0">
        <button type="button" class="btn btn--ghost" data-action="cancelar-form">Cancelar</button>
        <button type="button" class="btn btn--ghost" data-action="guardar-borrador">Guardar borrador</button>
        <button type="button" class="btn btn--primary" data-action="guardar">Guardar planeación</button>
      </div>
    </form>`;
}

function normalizeParticipantes(draft) {
  const count = Math.max(0, Math.min(30, Number(draft.cantidadEstudiantes) || 0));
  const current = Array.isArray(draft.participantes) ? draft.participantes : [];
  draft.cantidadEstudiantes = count;
  draft.participantes = Array.from({ length: count }, (_, index) => ({
    studentId: toStringSafe(current[index]?.studentId),
    nombre: toStringSafe(current[index]?.nombre),
    observacionEspecial: toStringSafe(current[index]?.observacionEspecial),
  }));
  return draft.participantes;
}

function bitacoraSuggestion(item) {
  const content = toStringSafe(item?.content).replace(/\s+/g, " ").trim();
  if (!content) return "Tiene historial, sin detalle disponible.";
  return content.length > 180 ? `${content.slice(0, 177)}...` : content;
}

function renderParticipantesEditor(draft) {
  const participantes = normalizeParticipantes(draft);
  const selected = new Set(participantes.map((p) => p.studentId).filter(Boolean));
  const studentOptions = pState.students
    .map((student) => ({ id: toStringSafe(student.id), nombre: toStringSafe(student.nombre) }))
    .filter((student) => student.id && student.nombre);
  const optionHtml = (currentId) => studentOptions.map((student) =>
    `<option value="${escapeHtml(student.id)}" ${currentId === student.id ? "selected" : ""} ${selected.has(student.id) && currentId !== student.id ? "disabled" : ""}>${escapeHtml(student.nombre)}</option>`
  ).join("");

  return `
    <div class="field-grid">
      ${field("Cantidad de estudiantes", `<input type="number" min="0" max="30" step="1" data-field="cantidadEstudiantes" value="${participantes.length}" inputmode="numeric" />`)}
    </div>
    ${participantes.length ? `
      <div class="planeador-participantes__mode chip-set">
        <button type="button" class="chip-toggle ${draft.modoObservaciones !== "personalizado" ? "is-active" : ""}" data-action="set-modo-observaciones" data-value="todos">Lo mismo aplica para todos</button>
        <button type="button" class="chip-toggle ${draft.modoObservaciones === "personalizado" ? "is-active" : ""}" data-action="set-modo-observaciones" data-value="personalizado">Personalizar por estudiante</button>
      </div>
      ${draft.modoObservaciones !== "personalizado"
        ? field("Observación o ajuste para todo el grupo (opcional)", `<textarea data-field="observacionesGrupo" placeholder="Ej.: priorizar escucha activa y alternar turnos breves.">${escapeHtml(draft.observacionesGrupo)}</textarea>`)
        : ""}
      <div class="planeador-participantes__list">
        ${participantes.map((participant, index) => {
          const history = pState.participantHistory[participant.studentId];
          return `<article class="planeador-participante-card">
            <label class="field"><span>Estudiante ${index + 1}</span>
              <select data-participant-index="${index}"><option value="">Selecciona del listado real</option>${optionHtml(participant.studentId)}</select>
            </label>
            ${participant.studentId ? `<p class="planeador-participante-card__history"><strong>Última bitácora:</strong> ${escapeHtml(history === undefined ? "Cargando contexto..." : history ? bitacoraSuggestion(history) : "Aún no tiene bitácoras registradas.")}</p>` : ""}
            ${draft.modoObservaciones === "personalizado" ? field("Observación especial (opcional)", `<textarea data-participant-note="${index}" placeholder="Ej.: necesita una variación, reto o seguimiento concreto.">${escapeHtml(participant.observacionEspecial)}</textarea>`) : ""}
          </article>`;
        }).join("")}
      </div>`
      : `<p class="chip-hint">Indica cuántos vienen para elegirlos desde el listado de estudiantes o dejar la planeación como referencia general.</p>`}
  `;
}

// Campo multivalor estilo bitácoras: chips seleccionados (clic para quitar),
// input libre (Enter para agregar) con datalist, y chips sugeridos del catálogo.
function renderMultiCatalogField(key, label, placeholder, selected = [], options = []) {
  const sel = toArraySafe(selected);
  const opts = toArraySafe(options);
  const selectedSet = new Set(sel.map((s) => String(s).toLowerCase()));
  const sugeridas = opts.filter((o) => !selectedSet.has(String(o).toLowerCase())).slice(0, 14);
  const listId = `dl-${key}`;

  return `
    <div class="multi-field">
      <label class="multi-field__label">${label}</label>
      <div class="chip-set" data-chips="${key}">
        ${sel.length
          ? sel.map((v) => `<button type="button" class="chip-toggle is-active" data-action="remove-componente" data-key="${key}" data-value="${escapeHtml(v)}" title="Quitar">${escapeHtml(v)} ✕</button>`).join("")
          : '<span class="chip-hint" style="margin:0">Sin selección todavía.</span>'}
      </div>
      <div class="multi-field__add">
        <input type="text" data-add-input="${key}" list="${listId}" placeholder="${escapeHtml(placeholder)}" />
        <datalist id="${listId}">${opts.map((o) => `<option value="${escapeHtml(o)}"></option>`).join("")}</datalist>
        <button type="button" class="btn btn--ghost btn--sm" data-action="add-componente" data-key="${key}">Agregar</button>
      </div>
      ${sugeridas.length ? `<div class="chip-set" style="margin-top:0.35rem">
        ${sugeridas.map((o) => `<button type="button" class="chip-suggest" data-action="add-componente-sug" data-key="${key}" data-value="${escapeHtml(o)}">+ ${escapeHtml(o)}</button>`).join("")}
      </div>` : ""}
    </div>`;
}

/* ==========================================================================
   COSECHA DEL FORMULARIO (DOM -> draft)
   ========================================================================== */

function harvestForm() {
  const form = viewRoot?.querySelector("[data-planeacion-form]");
  if (!form || !pState.draft) return;
  const d = pState.draft;

  form.querySelectorAll("[data-field]").forEach((el) => {
    const key = el.dataset.field;
    const value = el.type === "checkbox" ? el.checked : el.value;

    if (key.startsWith("momento.")) {
      d.momentosClase[key.slice(8)] = value;
    } else if (key.startsWith("adapt.")) {
      d.adaptaciones[key.slice(6)] = value;
    } else if (key.startsWith("evidencia.")) {
      d.evidenciaEsperada[key.slice(10)] = value;
    } else if (key.startsWith("reemp.")) {
      d.reemplazo[key.slice(6)] = value;
    } else if (key === "materialesExtra") {
      // se procesa junto a los checkboxes abajo
      d._materialesExtra = value;
    } else {
      d[key] = value;
    }
  });

  normalizeParticipantes(d);
  form.querySelectorAll("[data-participant-index]").forEach((el) => {
    const index = Number(el.dataset.participantIndex);
    const student = pState.students.find((item) => toStringSafe(item.id) === el.value);
    d.participantes[index] = {
      ...d.participantes[index],
      studentId: toStringSafe(student?.id),
      nombre: toStringSafe(student?.nombre),
    };
  });
  form.querySelectorAll("[data-participant-note]").forEach((el) => {
    const index = Number(el.dataset.participantNote);
    if (d.participantes[index]) d.participantes[index].observacionEspecial = el.value;
  });

  // Componentes/categorías: rescata texto pendiente en los inputs de agregar.
  form.querySelectorAll("[data-add-input]").forEach((el) => {
    const key = el.dataset.addInput;
    const val = el.value.trim();
    if (!val) return;
    const cur = toArraySafe(d[key]);
    if (!cur.some((x) => String(x).toLowerCase() === val.toLowerCase())) {
      d[key] = [...cur, val];
    }
  });

  // Materiales = checkboxes marcados + extras del textarea
  const checked = [...form.querySelectorAll("[data-material]:checked")].map((el) => el.value);
  const extras = toStringSafe(d._materialesExtra)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  d.materiales = [...new Set([...checked, ...extras])];
  delete d._materialesExtra;
}

/* ==========================================================================
   DETALLE
   ========================================================================== */

function renderDetail() {
  const p = pState.planeaciones.find((x) => x.id === pState.detailId);
  if (!p) {
    pState.mode = "list";
    return renderList();
  }
  const comp = arteMeta(p.arte);
  const tipo = TIPOS_CLASE.find((t) => t.value === p.tipoClase);
  const access = resolveUserAccess(getState()?.auth?.user);

  const momentos = MOMENTOS.map((m) => {
    const txt = p.momentosClase?.[m.key];
    if (!txt) return "";
    return `<div class="detalle-momento"><strong>${m.icon} ${escapeHtml(m.label)}:</strong><p>${escapeHtml(txt)}</p></div>`;
  }).join("");

  const comentarios = toArraySafe(p.comentariosCoordinacion);

  return `
    <div class="detalle">
      <div class="detalle-actions btn-group">
        <button type="button" class="btn btn--ghost btn--sm" data-action="volver-lista">← Volver</button>
        <button type="button" class="btn btn--ghost btn--sm" data-action="editar" data-id="${p.id}">✏️ Editar</button>
        <button type="button" class="btn btn--ghost btn--sm" data-action="duplicar" data-id="${p.id}">📑 Duplicar</button>
        <button type="button" class="btn btn--ghost btn--sm" data-action="copiar-resumen" data-id="${p.id}">📋 Copiar resumen</button>
        <button type="button" class="btn btn--primary btn--sm" data-action="whatsapp" data-id="${p.id}">📲 WhatsApp</button>
        <button type="button" class="btn btn--ghost btn--sm" data-action="imprimir">🖨️ Imprimir / PDF</button>
      </div>

      <section class="detalle-section">
        <div class="planeacion-card__head">
          <span class="planeacion-card__componente"><span class="icon">${comp.icon}</span>${escapeHtml(comp.label)}</span>
          <span class="estado-badge" style="background:${ESTADO_COLORS[p.estado] || "#94a3b8"}">${escapeHtml(ESTADO_LABELS[p.estado] || p.estado)}</span>
        </div>
        <h2 style="margin:0.5rem 0">${escapeHtml(p.grupoNombre || "Grupo")} ${p.esReemplazo ? '<span class="tag-reemplazo">REEMPLAZO</span>' : ""}</h2>
        <div class="planeacion-card__meta">
          <span>📅 ${escapeHtml(formatDisplayDate(p.fechaClase) || "Sin fecha")}</span>
          ${p.horaInicio ? `<span>⏰ ${escapeHtml(p.horaInicio)}${p.horaFin ? `–${escapeHtml(p.horaFin)}` : ""}</span>` : ""}
          ${p.docenteNombre ? `<span>🧑‍🏫 ${escapeHtml(p.docenteNombre)}</span>` : ""}
          ${p.sede ? `<span>📍 ${escapeHtml(p.sede)}</span>` : ""}
          ${p.ciclo ? `<span>👥 ${escapeHtml(p.ciclo)}</span>` : ""}
          ${tipo ? `<span>🏷️ ${escapeHtml(tipo.label)}</span>` : ""}
          ${isAdminUser() && toStringSafe(p.ownerEmail) ? `<span>👤 ${escapeHtml(p.ownerEmail)}</span>` : ""}
        </div>
      </section>

      ${p.objetivo ? `<section class="detalle-section"><h3>🎯 Objetivo</h3><p>${escapeHtml(p.objetivo)}</p></section>` : ""}
      ${renderParticipantesDetail(p)}
      ${renderComponentesDetail(p)}
      ${momentos ? `<section class="detalle-section"><h3>Momentos de clase</h3>${momentos}</section>` : ""}
      ${renderAdaptacionesDetail(p)}
      ${toArraySafe(p.materiales).length ? `<section class="detalle-section"><h3>📦 Materiales</h3><div class="chip-set">${p.materiales.map((m) => `<span class="postit__chip" style="background:var(--bg-muted)">${escapeHtml(m)}</span>`).join("")}</div></section>` : ""}
      ${renderReemplazoDetail(p)}

      <section class="detalle-section">
        <h3>💬 Comentarios internos de coordinación</h3>
        ${comentarios.length ? comentarios.map((c) => `<div class="comentario"><span class="comentario__autor">${escapeHtml(c.autor || "Coordinación")}</span> <span class="comentario__fecha">${escapeHtml(formatDisplayDate(c.fecha) || "")}</span><p>${escapeHtml(c.texto)}</p></div>`).join("") : '<p style="color:var(--text-muted)">Sin comentarios todavía.</p>'}
        <div class="field" style="margin-top:0.75rem">
          <textarea data-comentario placeholder="Escribe un comentario para el docente..."></textarea>
          <div class="btn-group" style="margin-top:0.5rem">
            <button type="button" class="btn btn--ghost btn--sm" data-action="add-comentario" data-id="${p.id}">Agregar comentario</button>
          </div>
        </div>
      </section>
    </div>`;
}

function renderComponentesDetail(p) {
  const chips = (arr) => toArraySafe(arr).map((v) => `<span class="postit__chip" style="background:var(--bg-muted)">${escapeHtml(v)}</span>`).join("");
  const rows = [
    ["Categorías", p.categorias],
    ...COMPONENTES_BITACORA.map((c) => [c.label, p[c.key]]),
  ].filter(([, v]) => toArraySafe(v).length);
  if (!rows.length) return "";
  return `<section class="detalle-section"><h3>🎨 Componentes (${escapeHtml(arteMeta(p.arte).label)})</h3>
    ${rows.map(([k, v]) => `<div class="detalle-momento"><strong>${escapeHtml(k)}:</strong><div class="chip-set">${chips(v)}</div></div>`).join("")}
  </section>`;
}

function renderParticipantesDetail(p) {
  const participants = toArraySafe(p.participantes).filter((item) => toStringSafe(item?.nombre));
  const count = Number(p.cantidadEstudiantes) || participants.length;
  if (!count && !participants.length && !toStringSafe(p.observacionesGrupo)) return "";
  return `<section class="detalle-section"><h3>Estudiantes de la clase${count ? ` (${count})` : ""}</h3>
    ${participants.length ? `<div class="chip-set">${participants.map((item) => `<span class="postit__chip" style="background:var(--bg-muted)">${escapeHtml(item.nombre)}</span>`).join("")}</div>` : ""}
    ${toStringSafe(p.observacionesGrupo) ? `<p><strong>Para todo el grupo:</strong> ${escapeHtml(p.observacionesGrupo)}</p>` : ""}
    ${participants.filter((item) => toStringSafe(item.observacionEspecial)).map((item) => `<p><strong>${escapeHtml(item.nombre)}:</strong> ${escapeHtml(item.observacionEspecial)}</p>`).join("")}
  </section>`;
}

function renderAdaptacionesDetail(p) {
  const a = p.adaptaciones || {};
  const rows = [
    ["Nivel del grupo", (NIVELES_GRUPO.find((n) => n.value === a.nivelGrupo) || {}).label],
    ["Estudiantes nuevos", a.estudiantesNuevos ? "Sí" : ""],
    ["Grupo mixto", a.grupoMixto ? "Sí" : ""],
    ["Ajustes de la actividad", a.descripcion],
  ].filter(([, v]) => toStringSafe(v));
  if (!rows.length) return "";
  return `<section class="detalle-section"><h3>🔧 Adaptaciones</h3>${rows.map(([k, v]) => `<p><strong>${k}:</strong> ${escapeHtml(v)}</p>`).join("")}</section>`;
}

function renderReemplazoDetail(p) {
  if (!p.esReemplazo) return "";
  const r = p.reemplazo || {};
  const rows = [
    ["Docente titular", r.docenteTitular],
    ["Docente reemplazante", r.docenteReemplazante],
    ["Qué debe continuar", r.continuidad],
    ["Qué no debe cambiar", r.noCambiar],
    ["Indicaciones del grupo", r.indicacionesGrupo],
    ["Material previo", r.materialPrevio],
    ["Nivel real del grupo", r.nivelReal],
    ["Alertas", r.alertas],
    ["Evidencia a entregar", r.evidenciaSolicitada],
  ].filter(([, v]) => toStringSafe(v));
  if (!rows.length) return "";
  return `<section class="detalle-section reemplazo-block"><h3>🔁 Información para el reemplazo</h3>${rows.map(([k, v]) => `<p><strong>${k}:</strong> ${escapeHtml(v)}</p>`).join("")}</section>`;
}

/* ==========================================================================
   RESUMEN / COMPARTIR
   ========================================================================== */

function buildResumen(p) {
  const comp = arteMeta(p.arte);
  const tipo = (TIPOS_CLASE.find((t) => t.value === p.tipoClase) || {}).label || "";
  const m = p.momentosClase || {};
  const compLine = (label, arr) => {
    const vals = toArraySafe(arr);
    return vals.length ? `\n${label}: ${vals.join(", ")}` : "";
  };
  return `PLANEACIÓN DE CLASE MUSICALA

Fecha: ${formatDisplayDate(p.fechaClase) || "—"}
Docente: ${p.docenteNombre || "—"}
Grupo: ${p.grupoNombre || "—"}
Estudiantes: ${Number(p.cantidadEstudiantes) || toArraySafe(p.participantes).length || "—"}${toArraySafe(p.participantes).filter((item) => item?.nombre).length ? ` (${toArraySafe(p.participantes).filter((item) => item?.nombre).map((item) => item.nombre).join(", ")})` : ""}
Sede: ${p.sede || "—"}
Área artística: ${comp.label}
Tipo de clase: ${tipo}${p.esReemplazo ? " [REEMPLAZO]" : ""}

Objetivo: ${p.objetivo || "—"}
Categorías: ${toArraySafe(p.categorias).join(", ") || "—"}${compLine("Componente corporal", p.componenteCorporal)}${compLine("Componente técnico", p.componenteTecnico)}${compLine("Componente teórico", p.componenteTeorico)}${compLine("Componente de repertorio", p.componenteObras)}

Momentos de clase:
1. Bienvenida: ${m.bienvenida || "—"}
2. Calentamiento: ${m.calentamiento || "—"}
3. Desarrollo técnico: ${m.desarrolloTecnico || "—"}
4. Práctica / creación: ${m.practicaCreacion || "—"}
5. Cierre: ${m.cierre || "—"}

Materiales: ${toArraySafe(p.materiales).join(", ") || "—"}`;
}

async function copyResumen(p) {
  const text = buildResumen(p);
  try {
    await navigator.clipboard.writeText(text);
    showSuccess("Resumen copiado. Ya puedes pegarlo en WhatsApp.");
  } catch {
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    showSuccess("Resumen copiado.");
  }
}

function shareWhatsApp(p) {
  const text = buildResumen(p);
  const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
  window.open(url, "_blank", "noopener");
}

/* ==========================================================================
   TABLERO DE POST-ITS
   ========================================================================== */

function renderBoard() {
  return `
    <div class="planeador-toolbar">
      <p class="planeacion-block__hint">Organiza ideas antes de planear. Arrastra los post-its entre columnas.</p>
    </div>
    <div class="board">
      ${POSTIT_COLUMNAS.map((col) => renderBoardColumn(col)).join("")}
    </div>`;
}

function renderBoardColumn(col) {
  const items = pState.postits.filter((p) => p.columna === col.value && !p.archived);
  return `
    <div class="board-column" data-column="${col.value}">
      <div class="board-column__head">
        <span>${col.icon} ${escapeHtml(col.label)}</span>
        <span class="board-column__count">${items.length}</span>
      </div>
      ${items.map(renderPostit).join("")}
      <button type="button" class="board-add" data-action="add-postit" data-column="${col.value}">＋ Agregar</button>
    </div>`;
}

function renderPostit(p) {
  const color = (POSTIT_COLORES.find((c) => c.value === p.color) || POSTIT_COLORES[0]).hex;
  const comp = p.arte ? arteMeta(p.arte) : null;
  const estado = (POSTIT_ESTADOS.find((e) => e.value === p.estado) || {}).label || "";
  return `
    <div class="postit" draggable="true" data-postit="${p.id}" style="--postit-bg:${color}">
      <button type="button" class="postit__del" data-action="del-postit" data-id="${p.id}" title="Eliminar">×</button>
      <p class="postit__title" data-action="edit-postit" data-id="${p.id}">${escapeHtml(p.titulo || "Sin título")}</p>
      ${p.descripcion ? `<p class="postit__desc">${escapeHtml(p.descripcion)}</p>` : ""}
      <div class="postit__meta">
        ${comp ? `<span class="postit__chip">${comp.icon} ${escapeHtml(comp.label)}</span>` : ""}
        ${p.grupoNombre ? `<span class="postit__chip">👥 ${escapeHtml(p.grupoNombre)}</span>` : ""}
        ${estado ? `<span class="postit__chip">${escapeHtml(estado)}</span>` : ""}
      </div>
    </div>`;
}

/* ==========================================================================
   EVENTOS
   ========================================================================== */

function bindEvents() {
  if (!viewRoot) return;

  // Tabs
  viewRoot.querySelectorAll("[data-tab]").forEach((el) => {
    el.addEventListener("click", () => {
      pState.tab = el.dataset.tab;
      if (pState.tab === "planeaciones") pState.mode = "list";
      renderActive();
    });
  });

  // Filtros
  viewRoot.querySelectorAll("[data-filter]").forEach((el) => {
    const evt = el.tagName === "SELECT" ? "change" : "input";
    el.addEventListener(evt, () => {
      pState.filters[el.dataset.filter] = el.value;
      // Re-render solo de la lista preservando foco del search
      const content = viewRoot.querySelector("[data-planeador-content]");
      if (content) {
        content.innerHTML = renderList();
        bindEvents();
        if (el.dataset.filter === "query") {
          const input = viewRoot.querySelector('[data-filter="query"]');
          if (input) {
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
          }
        }
      }
    });
  });

  // Acciones generales (delegación)
  viewRoot.querySelectorAll("[data-action]").forEach((el) => {
    el.addEventListener("click", (e) => handleAction(el.dataset.action, el, e));
  });

  // Enter en los inputs de componentes/categorías = agregar valor
  viewRoot.querySelectorAll("[data-add-input]").forEach((el) => {
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      harvestForm();
      addComponenteValue(el.dataset.addInput, el.value);
      renderActive();
    });
  });

  viewRoot.querySelectorAll("[data-participant-index]").forEach((el) => {
    el.addEventListener("change", async () => {
      harvestForm();
      await refreshParticipantHistory();
      renderActive();
    });
  });

  viewRoot.querySelector("[data-field=\"cantidadEstudiantes\"]")?.addEventListener("change", () => {
    harvestForm();
    renderActive();
  });

  // Drag & drop del tablero
  bindBoardDnD();
}

async function handleAction(action, el) {
  const id = el.dataset.id;

  switch (action) {
    case "nueva":
      pState.draft = createEmptyPlaneacion({ fechaClase: getTodayDate(), docenteNombre: defaultTeacherName() });
      pState.draftId = null;
      pState.mode = "form";
      pState.showPlantillas = false;
      renderActive();
      break;

    case "nueva-blanco":
      pState.showPlantillas = false;
      renderActive();
      break;

    case "plantillas":
      pState.draft = createEmptyPlaneacion({ fechaClase: getTodayDate(), docenteNombre: defaultTeacherName() });
      pState.draftId = null;
      pState.mode = "form";
      pState.showPlantillas = true;
      renderActive();
      break;

    case "usar-plantilla": {
      const tpl = PLANTILLAS.find((t) => t.id === el.dataset.plantilla);
      if (tpl) {
        pState.draft = createEmptyPlaneacion({
          fechaClase: getTodayDate(),
          docenteNombre: defaultTeacherName(),
          ...tpl.apply,
        });
      }
      pState.showPlantillas = false;
      renderActive();
      break;
    }

    case "set-arte":
      harvestForm();
      pState.draft.arte = pState.draft.arte === el.dataset.arte ? "" : el.dataset.arte;
      renderActive();
      break;

    case "add-componente": {
      harvestForm();
      const input = viewRoot.querySelector(`[data-add-input="${el.dataset.key}"]`);
      addComponenteValue(el.dataset.key, input?.value);
      renderActive();
      break;
    }

    case "add-componente-sug":
      harvestForm();
      addComponenteValue(el.dataset.key, el.dataset.value);
      renderActive();
      break;

    case "remove-componente": {
      harvestForm();
      const k = el.dataset.key;
      pState.draft[k] = toArraySafe(pState.draft[k]).filter(
        (v) => String(v).toLowerCase() !== String(el.dataset.value).toLowerCase()
      );
      renderActive();
      break;
    }

    case "set-objetivo":
      harvestForm();
      pState.draft.objetivo = OBJETIVO_EJEMPLOS[Number(el.dataset.idx)] || "";
      renderActive();
      break;

    case "set-reemplazo":
      harvestForm();
      pState.draft.esReemplazo = el.dataset.value === "1";
      renderActive();
      break;

    case "set-modo-observaciones":
      harvestForm();
      pState.draft.modoObservaciones = el.dataset.value === "personalizado" ? "personalizado" : "todos";
      renderActive();
      break;

    case "guardar":
      await savePlaneacion("guardar");
      break;
    case "guardar-borrador":
      await savePlaneacion("borrador");
      break;

    case "cancelar-form":
      pState.mode = "list";
      pState.draft = null;
      pState.showPlantillas = false;
      renderActive();
      break;

    case "ver":
      pState.detailId = id;
      pState.mode = "detail";
      renderActive();
      break;

    case "volver-lista":
      pState.mode = "list";
      renderActive();
      break;

    case "editar": {
      const p = pState.planeaciones.find((x) => x.id === id) || (await getPlaneacion(id));
      pState.draft = createEmptyPlaneacion(p);
      pState.draftId = id;
      pState.mode = "form";
      pState.showPlantillas = false;
      renderActive();
      break;
    }

    case "duplicar":
      try {
        await duplicatePlaneacion(id);
        showSuccess("Planeación duplicada como borrador.");
        await loadData();
        pState.mode = "list";
        renderActive();
      } catch (err) {
        showError(err?.message || "No se pudo duplicar.");
      }
      break;

    case "eliminar":
      if (!confirm("¿Eliminar esta planeación? No se puede deshacer.")) break;
      try {
        await deletePlaneacion(id);
        pState.planeaciones = pState.planeaciones.filter((x) => x.id !== id);
        showSuccess("Planeación eliminada.");
        pState.mode = "list";
        renderActive();
      } catch (err) {
        showError(err?.message || "No se pudo eliminar.");
      }
      break;

    case "copiar-resumen": {
      const p = pState.planeaciones.find((x) => x.id === id);
      if (p) await copyResumen(p);
      break;
    }

    case "whatsapp": {
      const p = pState.planeaciones.find((x) => x.id === id) || (await getPlaneacion(id));
      if (p) shareWhatsApp(p);
      break;
    }

    case "imprimir":
      window.print();
      break;

    case "add-comentario": {
      const ta = viewRoot.querySelector("[data-comentario]");
      const texto = toStringSafe(ta?.value);
      if (!texto) { showInfo("Escribe un comentario primero."); break; }
      try {
        await addComentarioCoordinacion(id, { autor: defaultTeacherName() || "Coordinación", texto });
        await loadData();
        renderActive();
        showSuccess("Comentario agregado.");
      } catch (err) {
        showError(err?.message || "No se pudo agregar el comentario.");
      }
      break;
    }

    case "add-postit":
      await quickAddPostit(el.dataset.column);
      break;
    case "edit-postit":
      await editPostitPrompt(id);
      break;
    case "del-postit":
      if (!confirm("¿Eliminar este post-it?")) break;
      try {
        await deletePostit(id);
        pState.postits = pState.postits.filter((x) => x.id !== id);
        renderActive();
      } catch (err) {
        showError(err?.message || "No se pudo eliminar.");
      }
      break;

    default:
      break;
  }
}

// Sella el dueño en un objeto si aún no lo tiene (no sobrescribe, para que un
// admin que edita la planeación de un docente conserve el dueño original).
function stampOwner(obj = {}) {
  const u = currentUser();
  return {
    ...obj,
    ownerEmail: toStringSafe(obj.ownerEmail) || toStringSafe(u?.email).toLowerCase(),
    ownerUid: toStringSafe(obj.ownerUid) || toStringSafe(u?.uid),
  };
}

function addComponenteValue(key, rawValue) {
  const value = toStringSafe(rawValue);
  if (!key || !value || !pState.draft) return;
  const cur = toArraySafe(pState.draft[key]);
  if (cur.some((v) => String(v).toLowerCase() === value.toLowerCase())) return;
  pState.draft[key] = [...cur, value];
}

function defaultTeacherName() {
  const user = getState()?.auth?.user;
  return toStringSafe(user?.name || user?.email);
}

async function refreshParticipantHistory() {
  const ids = [...new Set(toArraySafe(pState.draft?.participantes).map((item) => toStringSafe(item?.studentId)).filter(Boolean))];
  if (!ids.length) return;
  try {
    const bitacoras = await getBitacorasByStudentIds(ids, { limit: 0 });
    const latestByStudent = {};
    bitacoras.forEach((bitacora) => {
      [...new Set([...toArraySafe(bitacora.studentIds), toStringSafe(bitacora.studentId)].filter(Boolean))].forEach((studentId) => {
        if (!ids.includes(studentId)) return;
        const current = latestByStudent[studentId];
        if (!current || toStringSafe(bitacora.fechaClase).localeCompare(toStringSafe(current.fechaClase)) > 0) {
          latestByStudent[studentId] = bitacora;
        }
      });
    });
    ids.forEach((id) => {
      if (!(id in latestByStudent)) latestByStudent[id] = null;
    });
    pState.participantHistory = { ...pState.participantHistory, ...latestByStudent };
  } catch (error) {
    console.warn("[Planeador] No se pudo cargar el contexto de bitácoras:", error);
  }
}

async function savePlaneacion(mode) {
  harvestForm();
  const d = pState.draft;
  if (!d) return;

  if (mode === "borrador" && d.estado !== "borrador") {
    d.estado = "borrador";
  }

  if (!toStringSafe(d.grupoNombre) && !toStringSafe(d.objetivo)) {
    showError("Agrega al menos el grupo o el objetivo antes de guardar.");
    return;
  }

  // Garantiza dueño (las reglas exigen ownerEmail == tu correo al crear).
  Object.assign(d, stampOwner(d));

  const isUpdating = Boolean(pState.draftId);
  const loadingToastId = showLoadingToast(
    isUpdating
      ? "Estamos actualizando la planeación."
      : "Estamos guardando la planeación.",
    { title: isUpdating ? "Actualizando" : "Guardando" }
  );

  try {
    if (pState.draftId) {
      await updatePlaneacion(pState.draftId, d);
    } else {
      const newId = await createPlaneacion(d);
      pState.draftId = newId;
    }
    resolveLoadingToast(loadingToastId, {
      type: "success",
      title: "Listo",
      message: isUpdating
        ? "La planeación se actualizó correctamente."
        : "La planeación se guardó correctamente.",
    });
    await loadData();
    pState.mode = "list";
    pState.draft = null;
    pState.draftId = null;
    renderActive();
  } catch (err) {
    console.error("[Planeador] Error guardando:", err);
    resolveLoadingToast(loadingToastId, {
      type: "error",
      title: "No se pudo guardar",
      message: err?.message || "No se pudo guardar la planeación.",
    });
  }
}

/* ----- Post-its: alta/edición rápida con prompt ----- */

async function quickAddPostit(columna) {
  const titulo = prompt("Título del post-it:");
  if (!titulo) return;
  const descripcion = prompt("Descripción (opcional):") || "";
  try {
    await createPostit(stampOwner(createEmptyPostit({
      titulo,
      descripcion,
      columna: columna || "ideas",
      docenteNombre: defaultTeacherName(),
      fecha: getTodayDate(),
    })));
    await loadData();
    renderActive();
  } catch (err) {
    showError(err?.message || "No se pudo crear el post-it.");
  }
}

async function editPostitPrompt(id) {
  const p = pState.postits.find((x) => x.id === id);
  if (!p) return;
  const titulo = prompt("Título:", p.titulo);
  if (titulo === null) return;
  const descripcion = prompt("Descripción:", p.descripcion) ?? p.descripcion;
  try {
    await updatePostit(id, { ...p, titulo, descripcion });
    await loadData();
    renderActive();
  } catch (err) {
    showError(err?.message || "No se pudo editar.");
  }
}

/* ----- Drag & drop ----- */

function bindBoardDnD() {
  const board = viewRoot.querySelector(".board");
  if (!board) return;

  let draggedId = null;

  board.querySelectorAll(".postit").forEach((el) => {
    el.addEventListener("dragstart", () => {
      draggedId = el.dataset.postit;
      el.classList.add("dragging");
    });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
  });

  board.querySelectorAll(".board-column").forEach((col) => {
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      col.classList.add("drag-over");
    });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("drag-over");
      const newColumn = col.dataset.column;
      if (!draggedId || !newColumn) return;
      const postit = pState.postits.find((x) => x.id === draggedId);
      if (!postit || postit.columna === newColumn) return;
      postit.columna = newColumn;
      renderActive();
      try {
        await updatePostit(draggedId, { ...postit });
      } catch (err) {
        showError("No se pudo mover el post-it.");
        await loadData();
        renderActive();
      }
    });
  });
}

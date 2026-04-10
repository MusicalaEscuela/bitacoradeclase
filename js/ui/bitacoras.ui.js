// js/ui/bitacoras.ui.js

import { getState } from "../state.js";
import { CONFIG } from "../config.js";
import {
  qs,
  renderHtml,
  delegate,
  escapeHtml,
} from "./dom.js";

const DEFAULT_SELECTORS = {
  list: "#bitacoras-list",
  detail: "#bitacora-detail",
  summary: "#bitacoras-summary",
};

let cleanupFns = [];

export function destroyBitacorasUI() {
  cleanupFns.forEach((cleanup) => {
    try {
      cleanup();
    } catch (error) {
      console.warn("No se pudo limpiar bitacoras.ui:", error);
    }
  });

  cleanupFns = [];
}

export function mountBitacorasUI(options = {}) {
  destroyBitacorasUI();

  const {
    root = document,
    selectors = DEFAULT_SELECTORS,
    onSelect = null,
    onOpenDetail = null,
  } = options;

  const listEl = qs(selectors.list, root);
  const detailEl = qs(selectors.detail, root);

  if (listEl) {
    cleanupFns.push(
      delegate(listEl, "click", "[data-bitacora-id]", (event, item) => {
        handleBitacoraSelection(event, item, {
          onSelect,
          onOpenDetail,
        });
      })
    );

    cleanupFns.push(
      delegate(listEl, "keydown", "[data-bitacora-id]", (event, item) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();

        handleBitacoraSelection(event, item, {
          onSelect,
          onOpenDetail,
        });
      })
    );
  }

  if (detailEl) {
    cleanupFns.push(
      delegate(detailEl, "click", "[data-bitacora-detail-action]", (event, button) => {
        const action = button.dataset.bitacoraDetailAction;
        const bitacora = getSelectedBitacoraFromState();

        if (!bitacora) return;

        if (action === "open" && typeof onOpenDetail === "function") {
          onOpenDetail(bitacora, event);
        }
      })
    );
  }
}

export function renderBitacorasUI(state = getState(), options = {}) {
  renderBitacorasSummary(state, options);
  renderBitacorasList(state, options);
  renderBitacoraDetail(state, options);
}

export function renderBitacorasSummary(state = getState(), options = {}) {
  const {
    root = document,
    selectors = DEFAULT_SELECTORS,
  } = options;

  const summaryEl = qs(selectors.summary, root);
  if (!summaryEl) return;

  const bitacoras = getBitacorasFromState(state);
  const loading = Boolean(state?.bitacoras?.loading);

  if (loading) {
    renderHtml(
      summaryEl,
      `<p class="bitacoras-summary__text">${escapeHtml(CONFIG?.text?.loading || "Cargando...")}</p>`
    );
    return;
  }

  if (!bitacoras.length) {
    renderHtml(
      summaryEl,
      `<p class="bitacoras-summary__text">Todavía no hay bitácoras registradas para este estudiante.</p>`
    );
    return;
  }

  const latest = bitacoras[0];
  const latestDate = formatDateLabel(
    latest?.displayDate ||
    latest?.date ||
    latest?.createdAt ||
    latest?.updatedAt ||
    ""
  );

  renderHtml(
    summaryEl,
    `
      <p class="bitacoras-summary__text">
        ${bitacoras.length} bitácora${bitacoras.length === 1 ? "" : "s"} registrada${bitacoras.length === 1 ? "" : "s"}.
        ${latestDate ? `Última: <strong>${escapeHtml(latestDate)}</strong>.` : ""}
      </p>
    `
  );
}

export function renderBitacorasList(state = getState(), options = {}) {
  const {
    root = document,
    selectors = DEFAULT_SELECTORS,
    emptyMessage = "Este estudiante todavía no tiene bitácoras.",
  } = options;

  const listEl = qs(selectors.list, root);
  if (!listEl) return;

  const loading = Boolean(state?.bitacoras?.loading);
  const bitacoras = getBitacorasFromState(state);
  const selectedId = getSelectedBitacoraId(state);

  if (loading) {
    renderHtml(listEl, renderBitacorasLoadingState());
    return;
  }

  if (!bitacoras.length) {
    renderHtml(listEl, renderBitacorasEmptyState(emptyMessage));
    return;
  }

  renderHtml(
    listEl,
    `
      <div class="bitacoras-list" role="list">
        ${bitacoras
          .map((bitacora) =>
            renderBitacoraItem(bitacora, {
              selected: String(bitacora?.id || "") === String(selectedId || ""),
            })
          )
          .join("")}
      </div>
    `
  );
}

export function renderBitacoraDetail(state = getState(), options = {}) {
  const {
    root = document,
    selectors = DEFAULT_SELECTORS,
  } = options;

  const detailEl = qs(selectors.detail, root);
  if (!detailEl) return;

  const loading = Boolean(state?.bitacoras?.loading);
  const selectedBitacora = getSelectedBitacoraFromState(state);

  if (loading) {
    renderHtml(detailEl, renderBitacoraDetailLoadingState());
    return;
  }

  if (!selectedBitacora) {
    renderHtml(detailEl, renderBitacoraDetailEmptyState());
    return;
  }

  renderHtml(detailEl, renderBitacoraDetailCard(selectedBitacora));
}

export function renderBitacoraItem(bitacora, options = {}) {
  const { selected = false } = options;
  const view = toBitacoraViewModel(bitacora);

  return `
    <article
      class="bitacora-item ${selected ? "is-selected" : ""}"
      data-bitacora-id="${escapeHtml(view.id)}"
      role="listitem"
      tabindex="0"
      aria-selected="${selected ? "true" : "false"}"
    >
      <div class="bitacora-item__header">
        <div class="bitacora-item__header-main">
          <h3 class="bitacora-item__title">${escapeHtml(view.title)}</h3>
          <p class="bitacora-item__date">${escapeHtml(view.dateLabel)}</p>
        </div>
        ${view.typeLabel ? `<span class="badge">${escapeHtml(view.typeLabel)}</span>` : ""}
      </div>

      <div class="bitacora-item__content">
        <p class="bitacora-item__excerpt">${escapeHtml(view.excerpt)}</p>
      </div>

      <div class="bitacora-item__footer">
        <span class="bitacora-item__author">${escapeHtml(view.authorLabel)}</span>
        ${
          view.hasAttachments
            ? `<span class="bitacora-item__attachments">📎 ${view.attachmentsCount} archivo${view.attachmentsCount === 1 ? "" : "s"}</span>`
            : ""
        }
      </div>
    </article>
  `;
}

export function renderBitacoraDetailCard(bitacora) {
  const view = toBitacoraViewModel(bitacora);

  return `
    <article class="bitacora-detail-card">
      <header class="bitacora-detail-card__header">
        <div>
          <p class="bitacora-detail-card__eyebrow">Bitácora seleccionada</p>
          <h3 class="bitacora-detail-card__title">${escapeHtml(view.title)}</h3>
        </div>

        <div class="bitacora-detail-card__meta-top">
          ${view.typeLabel ? `<span class="badge">${escapeHtml(view.typeLabel)}</span>` : ""}
        </div>
      </header>

      <dl class="bitacora-detail-card__meta">
        ${renderDetailMetaItem("Fecha", view.dateLabel)}
        ${renderDetailMetaItem("Autor", view.authorLabel)}
        ${renderDetailMetaItem("Estado", view.statusLabel)}
        ${renderDetailMetaItem("Archivos", view.hasAttachments ? `${view.attachmentsCount}` : "0")}
      </dl>

      <section class="bitacora-detail-card__section">
        <h4 class="bitacora-detail-card__section-title">Contenido</h4>
        <div class="bitacora-detail-card__body">
          ${renderMultilineText(view.content)}
        </div>
      </section>

      ${
        view.hasAttachments
          ? `
            <section class="bitacora-detail-card__section">
              <h4 class="bitacora-detail-card__section-title">Archivos adjuntos</h4>
              <ul class="bitacora-detail-card__attachments">
                ${view.attachments.map(renderAttachmentItem).join("")}
              </ul>
            </section>
          `
          : ""
      }

      <div class="bitacora-detail-card__actions">
        <button
          type="button"
          class="btn btn--ghost"
          data-bitacora-detail-action="open"
        >
          Abrir completa
        </button>
      </div>
    </article>
  `;
}

export function renderBitacorasLoadingState() {
  return `
    <div class="loading-state">
      <p class="loading-state__text">${escapeHtml(CONFIG?.text?.loading || "Cargando...")}</p>
    </div>
  `;
}

export function renderBitacoraDetailLoadingState() {
  return `
    <div class="loading-state loading-state--detail">
      <p class="loading-state__text">${escapeHtml(CONFIG?.text?.loading || "Cargando...")}</p>
    </div>
  `;
}

export function renderBitacorasEmptyState(message = "No hay bitácoras.") {
  return `
    <div class="empty-state empty-state--bitacoras">
      <p class="empty-state__text">${escapeHtml(message)}</p>
    </div>
  `;
}

export function renderBitacoraDetailEmptyState() {
  return `
    <div class="empty-state empty-state--detail">
      <p class="empty-state__text">
        Seleccionen una bitácora para ver el detalle.
      </p>
    </div>
  `;
}

function handleBitacoraSelection(event, item, handlers = {}) {
  const bitacoraId = String(item?.dataset?.bitacoraId || "").trim();
  if (!bitacoraId) return;

  const state = getState();
  const bitacoras = getBitacorasFromState(state);
  const selectedBitacora =
    bitacoras.find((entry) => String(entry?.id || "") === bitacoraId) || null;

  if (!selectedBitacora) return;

  if (typeof handlers.onSelect === "function") {
    handlers.onSelect(selectedBitacora, event);
  }

  const shouldOpen =
    event.type === "keydown" ||
    event.target.closest?.("[data-bitacora-open]");

  if (shouldOpen && typeof handlers.onOpenDetail === "function") {
    handlers.onOpenDetail(selectedBitacora, event);
  }
}

function getBitacorasFromState(state = getState()) {
  if (Array.isArray(state?.bitacoras?.filteredItems)) {
    return state.bitacoras.filteredItems;
  }

  if (Array.isArray(state?.bitacoras?.items)) {
    return state.bitacoras.items;
  }

  if (Array.isArray(state?.profile?.bitacoras)) {
    return state.profile.bitacoras;
  }

  if (Array.isArray(state?.editor?.bitacoras)) {
    return state.editor.bitacoras;
  }

  return [];
}

function getSelectedBitacoraId(state = getState()) {
  return (
    state?.bitacoras?.selectedId ||
    state?.bitacoras?.selected?.id ||
    state?.editor?.selectedBitacoraId ||
    state?.profile?.selectedBitacoraId ||
    null
  );
}

function getSelectedBitacoraFromState(state = getState()) {
  const selectedId = getSelectedBitacoraId(state);
  const bitacoras = getBitacorasFromState(state);

  if (!bitacoras.length) return null;

  if (selectedId) {
    const found = bitacoras.find(
      (entry) => String(entry?.id || "") === String(selectedId)
    );

    if (found) return found;
  }

  return bitacoras[0] || null;
}

function toBitacoraViewModel(bitacora = {}) {
  const content =
    bitacora.content ||
    bitacora.descripcion ||
    bitacora.description ||
    bitacora.text ||
    bitacora.texto ||
    bitacora.note ||
    "";

  const title =
    bitacora.title ||
    bitacora.titulo ||
    deriveTitleFromContent(content);

  const dateValue =
    bitacora.displayDate ||
    bitacora.date ||
    bitacora.fecha ||
    bitacora.createdAt ||
    bitacora.updatedAt ||
    "";

  const author =
    bitacora.authorName ||
    bitacora.author ||
    bitacora.docente ||
    bitacora.teacherName ||
    bitacora.createdByName ||
    "Sin autor registrado";

  const typeLabel =
    bitacora.typeLabel ||
    bitacora.type ||
    bitacora.tipo ||
    "";

  const statusLabel =
    normalizeStatusLabel(
      bitacora.statusLabel ||
      bitacora.status ||
      bitacora.estado ||
      "Registrada"
    );

  const attachments = normalizeAttachments(
    bitacora.attachments ||
    bitacora.files ||
    bitacora.archivos ||
    bitacora.uploads ||
    []
  );

  return {
    id: String(bitacora.id || ""),
    title: String(title || "Bitácora"),
    content: String(content || "Sin contenido registrado."),
    excerpt: buildExcerpt(content),
    dateLabel: formatDateLabel(dateValue) || "Fecha no disponible",
    authorLabel: String(author || "Sin autor registrado"),
    typeLabel: String(typeLabel || ""),
    statusLabel,
    attachments,
    attachmentsCount: attachments.length,
    hasAttachments: attachments.length > 0,
  };
}

function normalizeAttachments(list) {
  if (!Array.isArray(list)) return [];

  return list
    .map((item, index) => {
      if (!item) return null;

      if (typeof item === "string") {
        return {
          id: `attachment-${index}`,
          name: item,
          url: item,
          type: "",
        };
      }

      return {
        id: String(item.id || item.fileId || `attachment-${index}`),
        name: String(item.name || item.filename || item.fileName || "Archivo adjunto"),
        url: String(item.url || item.downloadUrl || item.link || ""),
        type: String(item.type || item.mimeType || ""),
      };
    })
    .filter(Boolean);
}

function renderAttachmentItem(file) {
  const label = escapeHtml(file?.name || "Archivo adjunto");
  const url = String(file?.url || "").trim();

  if (!url) {
    return `
      <li class="bitacora-attachment">
        <span class="bitacora-attachment__name">${label}</span>
      </li>
    `;
  }

  return `
    <li class="bitacora-attachment">
      <a
        class="bitacora-attachment__link"
        href="${escapeHtml(url)}"
        target="_blank"
        rel="noreferrer noopener"
      >
        ${label}
      </a>
    </li>
  `;
}

function renderDetailMetaItem(label, value) {
  return `
    <div class="bitacora-detail-card__meta-item">
      <dt class="bitacora-detail-card__meta-label">${escapeHtml(label)}</dt>
      <dd class="bitacora-detail-card__meta-value">${escapeHtml(String(value ?? ""))}</dd>
    </div>
  `;
}

function renderMultilineText(text) {
  const safe = escapeHtml(String(text || "").trim());

  if (!safe) {
    return `<p>Sin contenido registrado.</p>`;
  }

  return safe
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function buildExcerpt(content = "", maxLength = 140) {
  const normalized = String(content || "").replace(/\s+/g, " ").trim();

  if (!normalized) return "Sin contenido registrado.";
  if (normalized.length <= maxLength) return normalized;

  return `${normalized.slice(0, maxLength).trim()}…`;
}

function deriveTitleFromContent(content = "") {
  const normalized = String(content || "").replace(/\s+/g, " ").trim();

  if (!normalized) return "Bitácora";
  if (normalized.length <= 50) return normalized;

  return `${normalized.slice(0, 50).trim()}…`;
}

function formatDateLabel(value) {
  if (!value) return "";

  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleDateString("es-CO", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    }

    return value;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toLocaleDateString("es-CO", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  if (typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleDateString("es-CO", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    }
  }

  if (typeof value === "object") {
    if (typeof value.toDate === "function") {
      const date = value.toDate();
      if (date instanceof Date && !Number.isNaN(date.getTime())) {
        return date.toLocaleDateString("es-CO", {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
      }
    }

    if (typeof value.seconds === "number") {
      const parsed = new Date(value.seconds * 1000);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toLocaleDateString("es-CO", {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
      }
    }
  }

  return "";
}

function normalizeStatusLabel(status) {
  const value = String(status || "").trim();
  if (!value) return "Registrada";

  const lowered = value.toLowerCase();

  if (lowered === "draft") return "Borrador";
  if (lowered === "published") return "Publicada";
  if (lowered === "saved") return "Guardada";
  if (lowered === "active") return "Activa";
  if (lowered === "inactive") return "Inactiva";

  return value.charAt(0).toUpperCase() + value.slice(1);
}
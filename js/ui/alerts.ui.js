// js/ui/alerts.ui.js

import { qs, createElement, renderHtml, escapeHtml, delegate } from "./dom.js";

const DEFAULT_SELECTORS = {
  toastRoot: "#toast-root",
  inlineRoot: "#inline-alerts",
};

const DEFAULT_OPTIONS = {
  type: "info",
  title: "",
  message: "",
  duration: 3200,
  dismissible: true,
  autoClose: true,
};

let toastState = {
  root: null,
  items: new Map(),
  cleanupFns: [],
};

export function mountAlertsUI(options = {}) {
  const {
    root = document,
    selectors = DEFAULT_SELECTORS,
  } = options;

  destroyAlertsUI();

  toastState.root = ensureToastRoot(root, selectors.toastRoot);

  if (toastState.root) {
    const cleanup = delegate(
      toastState.root,
      "click",
      "[data-alert-dismiss]",
      (event, button) => {
        const toast = button.closest("[data-toast-id]");
        const toastId = toast?.dataset?.toastId;
        if (!toastId) return;

        dismissToast(toastId);
      }
    );

    toastState.cleanupFns.push(cleanup);
  }
}

export function destroyAlertsUI() {
  toastState.cleanupFns.forEach((cleanup) => {
    try {
      cleanup();
    } catch (error) {
      console.warn("No se pudo limpiar alerts.ui:", error);
    }
  });

  toastState.cleanupFns = [];

  toastState.items.forEach((entry, toastId) => {
    clearToastTimer(entry);
    const element = entry?.element;
    if (element?.parentNode) {
      element.parentNode.removeChild(element);
    }
  });

  toastState.items.clear();
  toastState.root = null;
}

export function showToast(input = {}) {
  const options =
    typeof input === "string"
      ? { ...DEFAULT_OPTIONS, message: input }
      : { ...DEFAULT_OPTIONS, ...input };

  const root = toastState.root || ensureToastRoot(document, DEFAULT_SELECTORS.toastRoot);
  if (!root) {
    console.warn("No se pudo mostrar toast: no existe contenedor.");
    return null;
  }

  const toastId = generateAlertId("toast");
  const toastEl = createToastElement(toastId, options);

  root.appendChild(toastEl);

  const entry = {
    id: toastId,
    element: toastEl,
    timerId: null,
    options,
  };

  toastState.items.set(toastId, entry);

  requestAnimationFrame(() => {
    toastEl.classList.add("is-visible");
  });

  if (options.autoClose && Number(options.duration) > 0) {
    entry.timerId = window.setTimeout(() => {
      dismissToast(toastId);
    }, Number(options.duration));
  }

  return toastId;
}

export function showSuccess(message, options = {}) {
  return showToast({
    ...options,
    type: "success",
    message,
  });
}

export function showError(message, options = {}) {
  return showToast({
    ...options,
    type: "error",
    message,
    duration: options.duration ?? 4200,
  });
}

export function showWarning(message, options = {}) {
  return showToast({
    ...options,
    type: "warning",
    message,
  });
}

export function showInfo(message, options = {}) {
  return showToast({
    ...options,
    type: "info",
    message,
  });
}

export function dismissToast(toastId) {
  const entry = toastState.items.get(String(toastId));
  if (!entry) return false;

  clearToastTimer(entry);

  const element = entry.element;
  if (!element) {
    toastState.items.delete(String(toastId));
    return false;
  }

  element.classList.remove("is-visible");
  element.classList.add("is-leaving");

  const removeNow = () => {
    if (element.parentNode) {
      element.parentNode.removeChild(element);
    }
    toastState.items.delete(String(toastId));
  };

  element.addEventListener("transitionend", removeNow, { once: true });

  window.setTimeout(removeNow, 260);

  return true;
}

export function clearToasts() {
  Array.from(toastState.items.keys()).forEach((toastId) => {
    dismissToast(toastId);
  });
}

export function renderInlineAlert(target, input = {}) {
  const element = resolveInlineTarget(target);
  if (!element) return null;

  const options =
    typeof input === "string"
      ? { ...DEFAULT_OPTIONS, message: input }
      : { ...DEFAULT_OPTIONS, ...input };

  renderHtml(
    element,
    createInlineAlertMarkup({
      type: options.type,
      title: options.title,
      message: options.message,
      dismissible: options.dismissible,
    })
  );

  bindInlineDismiss(element);

  return element;
}

export function showInlineSuccess(target, message, options = {}) {
  return renderInlineAlert(target, {
    ...options,
    type: "success",
    message,
  });
}

export function showInlineError(target, message, options = {}) {
  return renderInlineAlert(target, {
    ...options,
    type: "error",
    message,
  });
}

export function showInlineWarning(target, message, options = {}) {
  return renderInlineAlert(target, {
    ...options,
    type: "warning",
    message,
  });
}

export function showInlineInfo(target, message, options = {}) {
  return renderInlineAlert(target, {
    ...options,
    type: "info",
    message,
  });
}

export function clearInlineAlert(target) {
  const element = resolveInlineTarget(target);
  if (!element) return false;

  renderHtml(element, "");
  return true;
}

export function clearAllInlineAlerts(root = document, selector = ".inline-alert") {
  const elements = Array.from(root.querySelectorAll(selector));
  elements.forEach((element) => {
    if (element.parentNode && element.matches("[data-inline-alert-mounted='true']")) {
      element.innerHTML = "";
    } else {
      element.innerHTML = "";
    }
  });
}

function ensureToastRoot(root = document, selector = DEFAULT_SELECTORS.toastRoot) {
  let toastRoot = qs(selector, root);

  if (toastRoot) return toastRoot;

  toastRoot = createElement("div", {
    className: "toast-root",
    attrs: {
      id: selector.startsWith("#") ? selector.slice(1) : "toast-root",
      "aria-live": "polite",
      "aria-atomic": "false",
    },
  });

  document.body.appendChild(toastRoot);
  return toastRoot;
}

function createToastElement(toastId, options) {
  const type = normalizeAlertType(options.type);
  const title = String(options.title || getDefaultTitle(type)).trim();
  const message = String(options.message || "").trim();

  const toastEl = createElement("article", {
    className: `toast toast--${type}`,
    attrs: {
      role: type === "error" ? "alert" : "status",
      "data-toast-id": toastId,
    },
  });

  toastEl.innerHTML = `
    <div class="toast__content">
      <div class="toast__icon" aria-hidden="true">${getAlertIcon(type)}</div>
      <div class="toast__body">
        ${title ? `<h4 class="toast__title">${escapeHtml(title)}</h4>` : ""}
        <p class="toast__message">${escapeHtml(message || "Sin mensaje")}</p>
      </div>
      ${
        options.dismissible
          ? `
            <button
              type="button"
              class="toast__close"
              data-alert-dismiss="true"
              aria-label="Cerrar alerta"
            >
              ×
            </button>
          `
          : ""
      }
    </div>
  `;

  return toastEl;
}

function createInlineAlertMarkup(options = {}) {
  const type = normalizeAlertType(options.type);
  const title = String(options.title || getDefaultTitle(type)).trim();
  const message = String(options.message || "").trim();

  return `
    <div
      class="inline-alert inline-alert--${type}"
      role="${type === "error" ? "alert" : "status"}"
      data-inline-alert-mounted="true"
    >
      <div class="inline-alert__content">
        <div class="inline-alert__icon" aria-hidden="true">${getAlertIcon(type)}</div>
        <div class="inline-alert__body">
          ${title ? `<h4 class="inline-alert__title">${escapeHtml(title)}</h4>` : ""}
          <p class="inline-alert__message">${escapeHtml(message || "Sin mensaje")}</p>
        </div>
        ${
          options.dismissible
            ? `
              <button
                type="button"
                class="inline-alert__close"
                data-inline-alert-dismiss="true"
                aria-label="Cerrar mensaje"
              >
                ×
              </button>
            `
            : ""
        }
      </div>
    </div>
  `;
}

function bindInlineDismiss(container) {
  const dismissButton = container.querySelector("[data-inline-alert-dismiss]");
  if (!dismissButton) return;

  dismissButton.onclick = () => {
    container.innerHTML = "";
  };
}

function resolveInlineTarget(target) {
  if (!target) return qs(DEFAULT_SELECTORS.inlineRoot, document);
  if (typeof target === "string") return qs(target, document);
  return target instanceof Element ? target : null;
}

function normalizeAlertType(type) {
  const normalized = String(type || "info").trim().toLowerCase();

  if (["success", "error", "warning", "info"].includes(normalized)) {
    return normalized;
  }

  return "info";
}

function getDefaultTitle(type) {
  if (type === "success") return "Listo";
  if (type === "error") return "Ojo";
  if (type === "warning") return "Atención";
  return "Información";
}

function getAlertIcon(type) {
  if (type === "success") return "✓";
  if (type === "error") return "⚠";
  if (type === "warning") return "!";
  return "i";
}

function clearToastTimer(entry) {
  if (entry?.timerId) {
    window.clearTimeout(entry.timerId);
    entry.timerId = null;
  }
}

function generateAlertId(prefix = "alert") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
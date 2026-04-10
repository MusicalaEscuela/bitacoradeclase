// js/ui/process.ui.js

import {
  qs,
  qsa,
  createElement,
  addClass,
  removeClass,
  setAttribute,
  removeAttribute,
} from "./dom.js";

const BUTTON_STATE_KEY = "__processButtonState";
const BLOCK_STATE_KEY = "__processBlockState";

export function setButtonLoading(target, loading = true, options = {}) {
  const button = resolveElement(target);

  if (!button) return false;

  if (loading) {
    applyButtonLoading(button, options);
    return true;
  }

  clearButtonLoading(button, options);
  return true;
}

export function clearButtonLoading(target, options = {}) {
  const button = resolveElement(target);
  if (!button) return false;

  const state = button[BUTTON_STATE_KEY];
  if (!state) {
    removeClass(button, "is-loading", "is-busy");
    removeAttribute(button, "aria-busy");
    return true;
  }

  if (state.spinner?.parentNode) {
    state.spinner.parentNode.removeChild(state.spinner);
  }

  if (state.labelTarget && state.originalHtml !== undefined) {
    state.labelTarget.innerHTML = state.originalHtml;
  } else if (state.originalHtml !== undefined) {
    button.innerHTML = state.originalHtml;
  }

  button.disabled = Boolean(state.originalDisabled);
  removeClass(button, "is-loading", "is-busy");
  removeAttribute(button, "aria-busy");

  if (state.originalWidth) {
    button.style.width = state.originalWidth;
  } else {
    button.style.removeProperty("width");
  }

  delete button[BUTTON_STATE_KEY];
  return true;
}

export function withButtonLoading(target, asyncAction, options = {}) {
  const button = resolveElement(target);

  if (!button || typeof asyncAction !== "function") {
    return Promise.reject(
      new Error("withButtonLoading requiere un botón válido y una función async.")
    );
  }

  setButtonLoading(button, true, options);

  return Promise.resolve()
    .then(() => asyncAction())
    .finally(() => {
      clearButtonLoading(button);
    });
}

export function setBlockLoading(target, loading = true, options = {}) {
  const element = resolveElement(target);
  if (!element) return false;

  if (loading) {
    applyBlockLoading(element, options);
    return true;
  }

  clearBlockLoading(element);
  return true;
}

export function clearBlockLoading(target) {
  const element = resolveElement(target);
  if (!element) return false;

  const state = element[BLOCK_STATE_KEY];
  if (!state) {
    removeClass(element, "is-loading", "is-busy");
    removeAttribute(element, "aria-busy");
    return true;
  }

  if (state.overlay?.parentNode) {
    state.overlay.parentNode.removeChild(state.overlay);
  }

  if (state.disabledTargets?.length) {
    state.disabledTargets.forEach((entry) => {
      if (!entry?.element) return;
      entry.element.disabled = Boolean(entry.originalDisabled);
    });
  }

  removeClass(element, "is-loading", "is-busy");
  removeAttribute(element, "aria-busy");

  if (state.originalPositionStyle) {
    element.style.position = state.originalPositionStyle;
  } else if (state.positionWasInjected) {
    element.style.removeProperty("position");
  }

  delete element[BLOCK_STATE_KEY];
  return true;
}

export function disableGroup(targets, disabled = true) {
  const elements = normalizeElements(targets);

  elements.forEach((element) => {
    if ("disabled" in element) {
      element.disabled = Boolean(disabled);
    }
  });

  return elements.length > 0;
}

export function disableWithin(container, selector, disabled = true) {
  const root = resolveElement(container);
  if (!root || !selector) return false;

  const elements = qsa(selector, root);
  return disableGroup(elements, disabled);
}

export function setBusyState(target, busy = true, options = {}) {
  const element = resolveElement(target);
  if (!element) return false;

  const {
    className = "is-busy",
    label = "",
  } = options;

  if (busy) {
    addClass(element, className);
    setAttribute(element, "aria-busy", "true");
    if (label) setAttribute(element, "aria-label", label);
    return true;
  }

  removeClass(element, className);
  removeAttribute(element, "aria-busy");
  return true;
}

export function setSectionSkeleton(target, active = true, options = {}) {
  const element = resolveElement(target);
  if (!element) return false;

  const className = options.className || "is-skeleton";

  if (active) {
    addClass(element, className);
    setAttribute(element, "aria-busy", "true");
    return true;
  }

  removeClass(element, className);
  removeAttribute(element, "aria-busy");
  return true;
}

function applyButtonLoading(button, options = {}) {
  if (button[BUTTON_STATE_KEY]) return;

  const {
    text = "Guardando...",
    lockWidth = true,
    spinner = true,
    labelSelector = "[data-button-label]",
    loadingClass = "is-loading",
    busyClass = "is-busy",
  } = options;

  const labelTarget = qs(labelSelector, button);
  const originalHtml = labelTarget ? labelTarget.innerHTML : button.innerHTML;
  const originalDisabled = Boolean(button.disabled);
  const originalWidth = button.style.width || "";

  if (lockWidth) {
    const width = button.getBoundingClientRect().width;
    if (width > 0) {
      button.style.width = `${Math.ceil(width)}px`;
    }
  }

  addClass(button, loadingClass, busyClass);
  setAttribute(button, "aria-busy", "true");
  button.disabled = true;

  if (labelTarget) {
    labelTarget.innerHTML = escapeText(text);
  } else {
    button.innerHTML = escapeText(text);
  }

  let spinnerEl = null;

  if (spinner) {
    spinnerEl = createSpinner({
      className: "button-spinner",
      inline: true,
    });

    if (labelTarget?.parentNode) {
      labelTarget.parentNode.insertBefore(spinnerEl, labelTarget);
    } else {
      button.insertBefore(spinnerEl, button.firstChild);
    }
  }

  button[BUTTON_STATE_KEY] = {
    originalHtml,
    originalDisabled,
    originalWidth,
    labelTarget,
    spinner: spinnerEl,
  };
}

function applyBlockLoading(element, options = {}) {
  const existing = element[BLOCK_STATE_KEY];
  if (existing) return;

  const {
    message = "Cargando...",
    disableSelector = "button, input, select, textarea",
    overlayClass = "process-overlay",
    loadingClass = "is-loading",
    busyClass = "is-busy",
    lockInteraction = true,
  } = options;

  const computedPosition = window.getComputedStyle(element).position;
  const originalPositionStyle = element.style.position || "";
  let positionWasInjected = false;

  if (computedPosition === "static") {
    element.style.position = "relative";
    positionWasInjected = true;
  }

  addClass(element, loadingClass, busyClass);
  setAttribute(element, "aria-busy", "true");

  const disabledTargets = [];

  if (lockInteraction && disableSelector) {
    qsa(disableSelector, element).forEach((control) => {
      if (!("disabled" in control)) return;

      disabledTargets.push({
        element: control,
        originalDisabled: Boolean(control.disabled),
      });

      control.disabled = true;
    });
  }

  const overlay = createBlockOverlay({
    className: overlayClass,
    message,
  });

  element.appendChild(overlay);

  requestAnimationFrame(() => {
    addClass(overlay, "is-visible");
  });

  element[BLOCK_STATE_KEY] = {
    overlay,
    disabledTargets,
    originalPositionStyle,
    positionWasInjected,
  };
}

function createBlockOverlay(options = {}) {
  const {
    className = "process-overlay",
    message = "Cargando...",
  } = options;

  const overlay = createElement("div", {
    className,
    attrs: {
      role: "status",
      "aria-live": "polite",
    },
  });

  const spinner = createSpinner({
    className: "process-spinner",
    inline: false,
  });

  const text = createElement("p", {
    className: "process-overlay__text",
    text: message,
  });

  const box = createElement("div", {
    className: "process-overlay__box",
    children: [spinner, text],
  });

  overlay.appendChild(box);
  return overlay;
}

function createSpinner(options = {}) {
  const {
    className = "process-spinner",
    inline = false,
  } = options;

  const spinner = createElement("span", {
    className: `${className}${inline ? ` ${className}--inline` : ""}`,
    attrs: {
      "aria-hidden": "true",
    },
  });

  spinner.innerHTML = `
    <span class="${className}__ring"></span>
  `;

  return spinner;
}

function normalizeElements(targets) {
  if (!targets) return [];

  if (Array.isArray(targets)) {
    return targets.map(resolveElement).filter(Boolean);
  }

  if (
    typeof NodeList !== "undefined" && targets instanceof NodeList
  ) {
    return Array.from(targets).map(resolveElement).filter(Boolean);
  }

  if (
    typeof HTMLCollection !== "undefined" && targets instanceof HTMLCollection
  ) {
    return Array.from(targets).map(resolveElement).filter(Boolean);
  }

  const single = resolveElement(targets);
  return single ? [single] : [];
}

function resolveElement(target) {
  if (!target) return null;

  if (typeof target === "string") {
    return qs(target, document);
  }

  if (target instanceof Element) {
    return target;
  }

  return null;
}

function escapeText(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
// js/ui/dom.js

const DEFAULT_RENDER_OPTIONS = {
  replaceChildren: false,
};

export function qs(selector, scope = document) {
  if (!selector || !scope?.querySelector) return null;
  return scope.querySelector(selector);
}

export function qsa(selector, scope = document) {
  if (!selector || !scope?.querySelectorAll) return [];
  return Array.from(scope.querySelectorAll(selector));
}

export function byId(id, scope = document) {
  if (!id) return null;

  if (typeof scope.getElementById === "function") {
    return scope.getElementById(id);
  }

  return qs(`#${escapeCssIdentifier(id)}`, scope);
}

export function exists(selector, scope = document) {
  return Boolean(qs(selector, scope));
}

export function assertElement(selector, scope = document, message = "") {
  const element = qs(selector, scope);

  if (!element) {
    throw new Error(
      message || `No se encontró el elemento requerido: "${selector}".`
    );
  }

  return element;
}

export function isElement(value) {
  return value instanceof Element || value instanceof HTMLDocument;
}

export function createElement(tagName, options = {}) {
  const element = document.createElement(tagName);

  const {
    className,
    classNames,
    text,
    html,
    attrs,
    dataset,
    children,
    value,
    disabled,
    hidden,
  } = options;

  if (className) {
    element.className = className;
  }

  if (Array.isArray(classNames) && classNames.length) {
    element.classList.add(...classNames.filter(Boolean));
  }

  if (text !== undefined && text !== null) {
    element.textContent = String(text);
  }

  if (html !== undefined && html !== null) {
    element.innerHTML = String(html);
  }

  if (attrs && typeof attrs === "object") {
    Object.entries(attrs).forEach(([key, val]) => {
      if (val === null || val === undefined || val === false) return;
      element.setAttribute(key, String(val));
    });
  }

  if (dataset && typeof dataset === "object") {
    Object.entries(dataset).forEach(([key, val]) => {
      if (val === null || val === undefined) return;
      element.dataset[key] = String(val);
    });
  }

  if (value !== undefined) {
    element.value = value;
  }

  if (typeof disabled === "boolean") {
    element.disabled = disabled;
  }

  if (typeof hidden === "boolean") {
    element.hidden = hidden;
  }

  if (Array.isArray(children) && children.length) {
    children
      .filter(Boolean)
      .forEach((child) => {
        if (child instanceof Node) {
          element.appendChild(child);
        } else {
          element.appendChild(document.createTextNode(String(child)));
        }
      });
  }

  return element;
}

export function clearElement(target) {
  const element = resolveElement(target);
  if (!element) return;
  element.replaceChildren();
}

export function renderHtml(target, html = "", options = {}) {
  const element = resolveElement(target);
  if (!element) return null;

  const settings = {
    ...DEFAULT_RENDER_OPTIONS,
    ...options,
  };

  if (settings.replaceChildren) {
    const template = document.createElement("template");
    template.innerHTML = String(html ?? "");
    element.replaceChildren(template.content.cloneNode(true));
    return element;
  }

  element.innerHTML = String(html ?? "");
  return element;
}

export function renderText(target, text = "") {
  const element = resolveElement(target);
  if (!element) return null;

  element.textContent = String(text ?? "");
  return element;
}

export function appendHtml(target, html = "") {
  const element = resolveElement(target);
  if (!element) return null;

  element.insertAdjacentHTML("beforeend", String(html ?? ""));
  return element;
}

export function prependHtml(target, html = "") {
  const element = resolveElement(target);
  if (!element) return null;

  element.insertAdjacentHTML("afterbegin", String(html ?? ""));
  return element;
}

export function replaceWithHtml(target, html = "") {
  const element = resolveElement(target);
  if (!element) return null;

  const template = document.createElement("template");
  template.innerHTML = String(html ?? "");
  const fragment = template.content;

  element.replaceWith(fragment);
  return null;
}

export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function syncInputValue(target, nextValue = "") {
  const element = resolveElement(target);
  if (!element) return false;

  const value = nextValue ?? "";
  if (element.value !== value) {
    element.value = value;
    return true;
  }

  return false;
}

export function syncTextareaValue(target, nextValue = "") {
  return syncInputValue(target, nextValue);
}

export function syncTextContent(target, nextValue = "") {
  const element = resolveElement(target);
  if (!element) return false;

  const value = String(nextValue ?? "");
  if (element.textContent !== value) {
    element.textContent = value;
    return true;
  }

  return false;
}

export function setDisabled(target, disabled = true) {
  const elements = normalizeElements(target);
  elements.forEach((element) => {
    if ("disabled" in element) {
      element.disabled = Boolean(disabled);
    }
      });
}

export function setHidden(target, hidden = true) {
  const elements = normalizeElements(target);
  elements.forEach((element) => {
    element.hidden = Boolean(hidden);
  });
}

export function show(target) {
  setHidden(target, false);
}

export function hide(target) {
  setHidden(target, true);
}

export function addClass(target, ...classNames) {
  const validClassNames = classNames.flat().filter(Boolean);
  if (!validClassNames.length) return;

  normalizeElements(target).forEach((element) => {
    element.classList.add(...validClassNames);
  });
}

export function removeClass(target, ...classNames) {
  const validClassNames = classNames.flat().filter(Boolean);
  if (!validClassNames.length) return;

  normalizeElements(target).forEach((element) => {
    element.classList.remove(...validClassNames);
  });
}

export function toggleClass(target, className, force) {
  if (!className) return false;

  let lastResult = false;

  normalizeElements(target).forEach((element) => {
    lastResult =
      typeof force === "boolean"
        ? element.classList.toggle(className, force)
        : element.classList.toggle(className);
  });

  return lastResult;
}

export function setAttribute(target, name, value) {
  if (!name) return;

  normalizeElements(target).forEach((element) => {
    if (value === null || value === undefined || value === false) {
      element.removeAttribute(name);
      return;
    }

    element.setAttribute(name, String(value));
  });
}

export function removeAttribute(target, name) {
  if (!name) return;

  normalizeElements(target).forEach((element) => {
    element.removeAttribute(name);
  });
}

export function on(target, eventName, handler, options) {
  const elements = normalizeElements(target);
  elements.forEach((element) => {
    element.addEventListener(eventName, handler, options);
  });

  return () => {
    off(elements, eventName, handler, options);
  };
}

export function off(target, eventName, handler, options) {
  const elements = normalizeElements(target);
  elements.forEach((element) => {
    element.removeEventListener(eventName, handler, options);
  });
}

export function delegate(target, eventName, selector, handler, options) {
  const root = resolveElement(target);

  if (!root) {
    throw new Error("delegate requiere un elemento raíz válido.");
  }

  if (typeof handler !== "function") {
    throw new Error("delegate requiere un handler válido.");
  }

  const listener = (event) => {
    const matched = event.target?.closest?.(selector);

    if (!matched) return;
    if (!root.contains(matched)) return;

    handler(event, matched);
  };

  root.addEventListener(eventName, listener, options);

  return () => {
    root.removeEventListener(eventName, listener, options);
  };
}

export function getFormData(form) {
  const element = resolveElement(form);

  if (!(element instanceof HTMLFormElement)) {
    throw new Error("getFormData requiere un formulario válido.");
  }

  const formData = new FormData(element);
  const result = {};

  for (const [key, value] of formData.entries()) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      const current = result[key];
      result[key] = Array.isArray(current)
        ? [...current, value]
        : [current, value];
    } else {
      result[key] = value;
    }
  }

  return result;
}

export function getTrimmedValue(target, fallback = "") {
  const element = resolveElement(target);
  if (!element || !("value" in element)) return fallback;
  return String(element.value ?? "").trim();
}

export function focusElement(target, options) {
  const element = resolveElement(target);
  if (!element || typeof element.focus !== "function") return false;

  element.focus(options);
  return true;
}

export function resolveElement(target, scope = document) {
  if (!target) return null;

  if (isElement(target) || target === window || target === document) {
    return target;
  }

  if (typeof target === "string") {
    return qs(target, scope);
  }

  return null;
}

export function normalizeElements(target, scope = document) {
  if (!target) return [];

  if (typeof target === "string") {
    return qsa(target, scope);
  }

  if (isElement(target) || target === window || target === document) {
    return [target];
  }

  if (Array.isArray(target)) {
    return target.filter(
      (item) => isElement(item) || item === window || item === document
    );
  }

  if (target instanceof NodeList || target instanceof HTMLCollection) {
    return Array.from(target).filter((item) => isElement(item));
  }

  return [];
}

function escapeCssIdentifier(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }

  return String(value).replace(/[^a-zA-Z0-9\-_]/g, "\\$&");
}
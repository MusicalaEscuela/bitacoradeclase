const FIELD_ATTRIBUTES = [
  "data-repertoire-input", "data-repertoire-status-new", "data-repertoire-status",
  "data-repertoire-priority", "data-repertoire-start", "data-repertoire-completed",
  "data-repertoire-notes", "data-history-process-select", "data-history-time-input",
];
const FIELD_SELECTOR = FIELD_ATTRIBUTES.map((name) => `[${name}]`).join(",");

function fieldKey(field) {
  const section = field.closest("[id]")?.id || "";
  const card = field.closest("[data-history-card]");
  const record = card?.querySelector("[data-bitacora-id]")?.getAttribute("data-bitacora-id") || "";
  const attribute = FIELD_ATTRIBUTES.find((name) => field.hasAttribute(name));
  return JSON.stringify([section, record, attribute, field.getAttribute(attribute)]);
}

function initialValue(field) {
  if (field.tagName !== "SELECT") return field.defaultValue;
  return [...field.options].find((option) => option.defaultSelected)?.value || field.options[0]?.value || "";
}

// Only unsaved edits are restored: refreshed server values keep their authority.
export function captureProfileDrafts(root) {
  const active = root?.ownerDocument?.activeElement;
  return {
    fields: [...(root?.querySelectorAll(FIELD_SELECTOR) || [])]
      .filter((field) => field.value !== initialValue(field) || field === active)
      .map((field) => ({
        key: fieldKey(field), value: field.value, focused: field === active,
        start: field.selectionStart, end: field.selectionEnd,
      })),
    expanded: [...(root?.querySelectorAll("[data-history-card] details, [data-repertoire-item] details") || [])]
      .filter((details) => details.open)
      .map((details) => {
        const field = details.querySelector(FIELD_SELECTOR);
        return field ? fieldKey(field) : null;
      }).filter(Boolean),
  };
}

export function restoreProfileDrafts(root, snapshot) {
  const fields = new Map([...(root?.querySelectorAll(FIELD_SELECTOR) || [])].map((field) => [fieldKey(field), field]));
  for (const saved of snapshot?.fields || []) {
    const field = fields.get(saved.key);
    if (!field) continue;
    if (field.tagName === "SELECT" && ![...field.options].some((option) => option.value === saved.value)) continue;
    field.value = saved.value;
    if (saved.focused && !field.disabled) {
      field.focus({ preventScroll: true });
      if (typeof field.setSelectionRange === "function" && saved.start != null) field.setSelectionRange(saved.start, saved.end);
    }
  }
  for (const key of snapshot?.expanded || []) {
    const details = fields.get(key)?.closest("details");
    if (details) details.open = true;
  }
}

export function profileSaveErrorMessage(error) {
  const code = String(error?.code || "");
  if (code.includes("CONFIRMATION_FAILED")) return "Firebase recibió el cambio, pero no pudimos confirmar lo guardado. Recarga la ficha antes de volver a intentarlo.";
  if (/offline|unavailable|deadline-exceeded/.test(code)) return "No se pudo confirmar el guardado por conexión. Conservamos lo que escribiste; revisa internet y vuelve a intentarlo.";
  if (/unauthenticated|AUTH_REQUIRED/.test(code)) return "Tu sesión necesita verificarse. Conservamos lo que escribiste; vuelve a iniciar sesión antes de guardar.";
  if (/permission-denied/.test(code)) return "Firebase rechazó el guardado por permisos o validación. Conservamos lo que escribiste; revisa tu cuenta y los datos.";
  return error?.message || "No se pudo guardar. Conservamos lo que escribiste para que puedas reintentar.";
}

export class ProfileSaveFeedback {
  constructor() { this.operations = new Map(); }
  key(studentId, scope) { return JSON.stringify([studentId, scope]); }
  begin(studentId, scope) {
    const key = this.key(studentId, scope);
    if (this.operations.get(key)?.status === "saving") return false;
    this.operations.set(key, { status: "saving", message: "Guardando y verificando en Firebase…" });
    return true;
  }
  finish(studentId, scope, status, message) {
    this.operations.set(this.key(studentId, scope), { status, message });
  }
  render(root, studentId) {
    for (const container of root?.querySelectorAll("[data-profile-save-scope]") || []) {
      const operation = this.operations.get(this.key(studentId, container.getAttribute("data-profile-save-scope")));
      const busy = operation?.status === "saving";
      container.setAttribute("aria-busy", String(busy));
      const message = container.querySelector("[data-profile-save-message]");
      if (message) {
        message.textContent = operation?.message || "";
        message.dataset.status = operation?.status || "";
        message.setAttribute("role", operation?.status === "error" ? "alert" : "status");
      }
      for (const field of container.querySelectorAll("button, input, select, textarea")) {
        field.disabled = busy;
        if (field.matches("[data-repertoire-add], [data-repertoire-save], [data-history-action='assign-process']")) {
          if (!field.dataset.saveLabel) field.dataset.saveLabel = field.textContent.trim();
          field.textContent = busy ? "Guardando…" : field.dataset.saveLabel;
        }
      }
    }
  }
}

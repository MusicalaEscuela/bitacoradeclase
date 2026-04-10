// js/ui/form.ui.js

import { qs, qsa, getFormData, getTrimmedValue, delegate } from "./dom.js";
import {
  showInlineError,
  showInlineSuccess,
  clearInlineAlert,
  showError,
} from "./alerts.ui.js";
import { setButtonLoading, clearButtonLoading } from "./process.ui.js";

const DEFAULT_SELECTORS = {
  form: "#bitacora-form",
  title: '[name="title"]',
  content: '[name="content"]',
  type: '[name="type"]',
  studentId: '[name="studentId"]',
  files: '[name="files"]',
  submit: '[type="submit"]',
  reset: '[type="reset"]',
  inlineAlert: "#bitacora-form-alert",
  filesPreview: "#bitacora-files-preview",
};

const DEFAULT_TEXTS = {
  requiredTitle: "Pónganle un título a la bitácora.",
  requiredContent: "La bitácora no puede quedar vacía.",
  requiredStudent: "No hay estudiante seleccionado para guardar la bitácora.",
  genericSuccess: "Bitácora guardada correctamente.",
  genericError: "No se pudo guardar la bitácora.",
  filesEmpty: "No hay archivos seleccionados.",
};

let cleanupFns = [];
let currentOptions = null;

export function destroyFormUI() {
  cleanupFns.forEach((cleanup) => {
    try {
      cleanup();
    } catch (error) {
      console.warn("No se pudo limpiar form.ui:", error);
    }
  });

  cleanupFns = [];
  currentOptions = null;
}

export function mountFormUI(options = {}) {
  destroyFormUI();

  const mergedOptions = {
    root: document,
    selectors: { ...DEFAULT_SELECTORS, ...(options.selectors || {}) },
    texts: { ...DEFAULT_TEXTS, ...(options.texts || {}) },
    onSubmit: null,
    onReset: null,
    onChange: null,
    validate: null,
    ...options,
  };

  currentOptions = mergedOptions;

  const { root, selectors } = mergedOptions;
  const form = qs(selectors.form, root);

  if (!form) {
    console.warn("form.ui: no se encontró el formulario.");
    return null;
  }

  cleanupFns.push(
    form.addEventListener("submit", handleSubmitWrapper(mergedOptions))
  );

  cleanupFns.pop();
  const submitHandler = handleSubmitWrapper(mergedOptions);
  form.addEventListener("submit", submitHandler);
  cleanupFns.push(() => form.removeEventListener("submit", submitHandler));

  const resetHandler = handleResetWrapper(mergedOptions);
  form.addEventListener("reset", resetHandler);
  cleanupFns.push(() => form.removeEventListener("reset", resetHandler));

  const changeHandler = handleChangeWrapper(mergedOptions);
  form.addEventListener("input", changeHandler);
  form.addEventListener("change", changeHandler);
  cleanupFns.push(() => form.removeEventListener("input", changeHandler));
  cleanupFns.push(() => form.removeEventListener("change", changeHandler));

  const filesInput = qs(selectors.files, form);
  const filesPreview = qs(selectors.filesPreview, root);

  if (filesInput && filesPreview) {
    const removePreviewCleanup = delegate(
      filesPreview,
      "click",
      "[data-remove-file-index]",
      (event, button) => {
        event.preventDefault();
        const index = Number(button.dataset.removeFileIndex);
        removeSelectedFile(filesInput, index, filesPreview, mergedOptions);
      }
    );

    cleanupFns.push(removePreviewCleanup);
  }

  renderFilesPreview([], mergedOptions);
  clearFormFeedback(mergedOptions);

  return {
    form,
    getData: () => readBitacoraFormData(mergedOptions),
    validate: () => validateBitacoraForm(readBitacoraFormData(mergedOptions), mergedOptions),
    reset: () => resetBitacoraForm(mergedOptions),
    fill: (data) => fillBitacoraForm(data, mergedOptions),
  };
}

export function getFormElements(options = currentOptions || {}) {
  const mergedOptions = {
    root: document,
    selectors: { ...DEFAULT_SELECTORS, ...(options.selectors || {}) },
    ...options,
  };

  const { root, selectors } = mergedOptions;
  const form = qs(selectors.form, root);

  if (!form) return null;

  return {
    form,
    title: qs(selectors.title, form),
    content: qs(selectors.content, form),
    type: qs(selectors.type, form),
    studentId: qs(selectors.studentId, form),
    files: qs(selectors.files, form),
    submit: qs(selectors.submit, form),
    reset: qs(selectors.reset, form),
    inlineAlert: qs(selectors.inlineAlert, root),
    filesPreview: qs(selectors.filesPreview, root),
  };
}

export function readBitacoraFormData(options = currentOptions || {}) {
  const elements = getFormElements(options);
  if (!elements?.form) {
    return createEmptyFormData();
  }

  const raw = getFormData(elements.form);
  const files = getSelectedFiles(elements.files);

  return {
    ...raw,
    title: getTrimmedValue(elements.title),
    content: getTrimmedValue(elements.content),
    type: getTrimmedValue(elements.type),
    studentId: getTrimmedValue(elements.studentId),
    files,
  };
}

export function validateBitacoraForm(data, options = currentOptions || {}) {
  const texts = {
    ...DEFAULT_TEXTS,
    ...(options?.texts || {}),
  };

  const errors = {};

  if (!String(data?.studentId || "").trim()) {
    errors.studentId = texts.requiredStudent;
  }

  if (!String(data?.title || "").trim()) {
    errors.title = texts.requiredTitle;
  }

  if (!String(data?.content || "").trim()) {
    errors.content = texts.requiredContent;
  }

  if (typeof options?.validate === "function") {
    const customValidation = options.validate(data) || {};

    if (customValidation.errors && typeof customValidation.errors === "object") {
      Object.assign(errors, customValidation.errors);
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

export function fillBitacoraForm(data = {}, options = currentOptions || {}) {
  const elements = getFormElements(options);
  if (!elements?.form) return false;

  if (elements.title) elements.title.value = data.title || data.titulo || "";
  if (elements.content) {
    elements.content.value =
      data.content ||
      data.descripcion ||
      data.description ||
      data.text ||
      data.texto ||
      "";
  }
  if (elements.type) elements.type.value = data.type || data.tipo || "";
  if (elements.studentId) {
    elements.studentId.value =
      data.studentId ||
      data.student_id ||
      data.estudianteId ||
      data.student?.id ||
      "";
  }

  clearFormErrors(options);
  clearFormFeedback(options);
  renderFilesPreview([], options);

  return true;
}

export function resetBitacoraForm(options = currentOptions || {}) {
  const elements = getFormElements(options);
  if (!elements?.form) return false;

  const currentStudentId = elements.studentId?.value || "";

  elements.form.reset();

  if (elements.studentId && currentStudentId) {
    elements.studentId.value = currentStudentId;
  }

  clearFormErrors(options);
  clearFormFeedback(options);
  renderFilesPreview([], options);

  return true;
}

export function setBitacoraFormSubmitting(submitting = true, options = currentOptions || {}) {
  const elements = getFormElements(options);
  if (!elements?.form) return false;

  if (submitting) {
    if (elements.submit) {
      setButtonLoading(elements.submit, true, {
        text: "Guardando...",
      });
    }

    toggleFormDisabled(elements.form, true, {
      skipSelector: options?.selectors?.submit || DEFAULT_SELECTORS.submit,
    });

    return true;
  }

  if (elements.submit) {
    clearButtonLoading(elements.submit);
  }

  toggleFormDisabled(elements.form, false);
  return true;
}

export function showFormSuccess(message, options = currentOptions || {}) {
  const elements = getFormElements(options);
  const text = message || options?.texts?.genericSuccess || DEFAULT_TEXTS.genericSuccess;

  clearFormErrors(options);

  if (elements?.inlineAlert) {
    showInlineSuccess(elements.inlineAlert, text, {
      title: "Listo",
    });
    return;
  }

  showError(text);
}

export function showFormError(message, options = currentOptions || {}) {
  const elements = getFormElements(options);
  const text = message || options?.texts?.genericError || DEFAULT_TEXTS.genericError;

  if (elements?.inlineAlert) {
    showInlineError(elements.inlineAlert, text, {
      title: "Ojo",
    });
    return;
  }

  showError(text);
}

export function clearFormFeedback(options = currentOptions || {}) {
  const elements = getFormElements(options);
  if (elements?.inlineAlert) {
    clearInlineAlert(elements.inlineAlert);
  }
}

export function clearFormErrors(options = currentOptions || {}) {
  const elements = getFormElements(options);
  if (!elements?.form) return false;

  qsa(".is-invalid", elements.form).forEach((field) => {
    field.classList.remove("is-invalid");
    field.removeAttribute("aria-invalid");
  });

  qsa("[data-field-error]", elements.form).forEach((node) => {
    node.textContent = "";
    node.hidden = true;
  });

  return true;
}

export function applyFormErrors(errors = {}, options = currentOptions || {}) {
  const elements = getFormElements(options);
  if (!elements?.form) return false;

  clearFormErrors(options);

  Object.entries(errors).forEach(([fieldName, message]) => {
    const field = elements.form.querySelector(`[name="${fieldName}"]`);
    if (field) {
      field.classList.add("is-invalid");
      field.setAttribute("aria-invalid", "true");
    }

    const errorNode = elements.form.querySelector(`[data-field-error="${fieldName}"]`);
    if (errorNode) {
      errorNode.textContent = String(message || "");
      errorNode.hidden = false;
    }
  });

  const firstFieldName = Object.keys(errors)[0];
  if (firstFieldName) {
    const firstField = elements.form.querySelector(`[name="${firstFieldName}"]`);
    firstField?.focus?.();
  }

  return true;
}

export function renderFilesPreview(files = [], options = currentOptions || {}) {
  const elements = getFormElements(options);
  if (!elements?.filesPreview) return false;

  if (!files.length) {
    elements.filesPreview.innerHTML = `
      <div class="files-preview files-preview--empty">
        <p class="files-preview__text">${options?.texts?.filesEmpty || DEFAULT_TEXTS.filesEmpty}</p>
      </div>
    `;
    return true;
  }

  elements.filesPreview.innerHTML = `
    <ul class="files-preview__list">
      ${files
        .map(
          (file, index) => `
            <li class="files-preview__item">
              <div class="files-preview__meta">
                <span class="files-preview__name">${escapeText(file.name || `Archivo ${index + 1}`)}</span>
                <span class="files-preview__size">${formatFileSize(file.size || 0)}</span>
              </div>
              <button
                type="button"
                class="files-preview__remove"
                data-remove-file-index="${index}"
                aria-label="Quitar archivo ${escapeText(file.name || `${index + 1}`)}"
              >
                ×
              </button>
            </li>
          `
        )
        .join("")}
    </ul>
  `;

  return true;
}

function handleSubmitWrapper(options) {
  return async function handleFormSubmit(event) {
    event.preventDefault();

    const data = readBitacoraFormData(options);
    const validation = validateBitacoraForm(data, options);

    clearFormFeedback(options);

    if (!validation.valid) {
      applyFormErrors(validation.errors, options);
      showFormError(Object.values(validation.errors)[0], options);
      return;
    }

    clearFormErrors(options);
    setBitacoraFormSubmitting(true, options);

    try {
      if (typeof options.onSubmit !== "function") {
        throw new Error("No se definió onSubmit para el formulario.");
      }

      const result = await options.onSubmit(data, {
        form: getFormElements(options)?.form || null,
      });

      if (result?.ok === false) {
        throw new Error(result?.message || options?.texts?.genericError || DEFAULT_TEXTS.genericError);
      }

      showFormSuccess(
        result?.message || options?.texts?.genericSuccess || DEFAULT_TEXTS.genericSuccess,
        options
      );

      if (result?.reset !== false) {
        resetBitacoraForm(options);
      }
    } catch (error) {
      console.error("Error al enviar formulario de bitácora:", error);
      showFormError(
        error?.message || options?.texts?.genericError || DEFAULT_TEXTS.genericError,
        options
      );
    } finally {
      setBitacoraFormSubmitting(false, options);
    }
  };
}

function handleResetWrapper(options) {
  return function handleFormReset() {
    window.setTimeout(() => {
      const elements = getFormElements(options);
      const currentStudentId = elements?.studentId?.value || "";

      clearFormErrors(options);
      clearFormFeedback(options);
      renderFilesPreview([], options);

      if (elements?.studentId && currentStudentId) {
        elements.studentId.value = currentStudentId;
      }

      if (typeof options.onReset === "function") {
        options.onReset({
          form: elements?.form || null,
        });
      }
    }, 0);
  };
}

function handleChangeWrapper(options) {
  return function handleFormChange(event) {
    const elements = getFormElements(options);
    if (!elements?.form) return;

    const target = event.target;

    if (target?.name) {
      clearSingleFieldError(target.name, options);
    }

    if (target === elements.files) {
      renderFilesPreview(getSelectedFiles(elements.files), options);
    }

    if (typeof options.onChange === "function") {
      options.onChange(readBitacoraFormData(options), event);
    }
  };
}

function clearSingleFieldError(fieldName, options = currentOptions || {}) {
  const elements = getFormElements(options);
  if (!elements?.form || !fieldName) return;

  const field = elements.form.querySelector(`[name="${fieldName}"]`);
  if (field) {
    field.classList.remove("is-invalid");
    field.removeAttribute("aria-invalid");
  }

  const errorNode = elements.form.querySelector(`[data-field-error="${fieldName}"]`);
  if (errorNode) {
    errorNode.textContent = "";
    errorNode.hidden = true;
  }
}

function toggleFormDisabled(form, disabled = true, options = {}) {
  if (!(form instanceof HTMLFormElement)) return false;

  const controls = qsa("input, textarea, select, button", form);
  const skipSelector = options.skipSelector || null;
  const skipControl = skipSelector ? qs(skipSelector, form) : null;

  controls.forEach((control) => {
    if (skipControl && control === skipControl) return;
    control.disabled = Boolean(disabled);
  });

  return true;
}

function getSelectedFiles(input) {
  if (!input?.files) return [];
  return Array.from(input.files);
}

function removeSelectedFile(input, index, previewContainer, options = currentOptions || {}) {
  if (!input?.files) return false;

  const files = Array.from(input.files);
  if (index < 0 || index >= files.length) return false;

  files.splice(index, 1);

  const dataTransfer = new DataTransfer();
  files.forEach((file) => dataTransfer.items.add(file));
  input.files = dataTransfer.files;

  renderFilesPreview(files, options);

  if (previewContainer && !files.length) {
    renderFilesPreview([], options);
  }

  return true;
}

function createEmptyFormData() {
  return {
    title: "",
    content: "",
    type: "",
    studentId: "",
    files: [],
  };
}

function formatFileSize(bytes = 0) {
  const value = Number(bytes) || 0;

  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;

  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function escapeText(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
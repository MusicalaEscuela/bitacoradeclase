// js/api/uploads.api.js

import { CONFIG, getApiUrl } from '../config.js';

const DEFAULT_TIMEOUT = 30000;

function createApiError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

function withTimeout(ms = DEFAULT_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeoutId),
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveUploadEndpoint() {
  const url = getApiUrl('upload');

  if (!url) {
    throw createApiError(
      'No se pudo resolver el endpoint "upload" desde config.js.',
      {
        code: 'MISSING_UPLOAD_ENDPOINT',
        config: CONFIG,
      }
    );
  }

  return url;
}

async function parseJsonResponse(response) {
  const rawText = await response.text();

  if (!rawText || !rawText.trim()) {
    throw createApiError('La respuesta del servidor llegó vacía.', {
      code: 'EMPTY_RESPONSE',
      status: response.status,
    });
  }

  try {
    return JSON.parse(rawText);
  } catch (error) {
    throw createApiError('La respuesta del servidor no es JSON válido.', {
      code: 'INVALID_JSON',
      status: response.status,
      responseText: rawText,
      cause: error,
    });
  }
}

async function requestJson(url, options = {}) {
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT;

  const { signal, clear } = withTimeout(timeoutMs);

  try {
    const response = await fetch(url, {
      method: options.method || 'POST',
      headers: {
        Accept: 'application/json',
        ...(options.headers || {}),
      },
      body: options.body,
      signal,
      redirect: 'follow',
      cache: 'no-store',
    });

    const payload = await parseJsonResponse(response);

    if (!response.ok) {
      throw createApiError(
        payload?.message ||
          payload?.error ||
          `Error HTTP ${response.status} al subir archivo.`,
        {
          code: 'HTTP_ERROR',
          status: response.status,
          payload,
        }
      );
    }

    if (payload?.ok === false || payload?.success === false) {
      throw createApiError(
        payload?.message || payload?.error || 'El servidor respondió con error al subir el archivo.',
        {
          code: 'API_ERROR',
          status: response.status,
          payload,
        }
      );
    }

    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw createApiError('La subida del archivo tardó demasiado y fue cancelada.', {
        code: 'REQUEST_TIMEOUT',
      });
    }

    if (error instanceof Error) {
      throw error;
    }

    throw createApiError('Ocurrió un error inesperado al subir el archivo.', {
      code: 'UNKNOWN_REQUEST_ERROR',
      cause: error,
    });
  } finally {
    clear();
  }
}

function validateFile(file) {
  if (!(file instanceof File)) {
    throw createApiError('El archivo enviado no es válido.', {
      code: 'INVALID_FILE',
    });
  }

  if (!file.name) {
    throw createApiError('El archivo no tiene nombre válido.', {
      code: 'INVALID_FILE_NAME',
    });
  }

  if (file.size <= 0) {
    throw createApiError('El archivo está vacío.', {
      code: 'EMPTY_FILE',
    });
  }

  return file;
}

function buildUploadFormData(file, options = {}) {
  const validFile = validateFile(file);
  const formData = new FormData();

  formData.append(options.fileFieldName || 'file', validFile, validFile.name);

  if (options.studentId) {
    formData.append('studentId', String(options.studentId));
  }

  if (options.bitacoraId) {
    formData.append('bitacoraId', String(options.bitacoraId));
  }

  if (options.folder) {
    formData.append('folder', String(options.folder));
  }

  if (options.category) {
    formData.append('category', String(options.category));
  }

  if (options.source) {
    formData.append('source', String(options.source));
  }

  if (options.description) {
    formData.append('description', String(options.description));
  }

  if (options.tags && Array.isArray(options.tags)) {
    formData.append('tags', JSON.stringify(options.tags));
  }

  if (isPlainObject(options.metadata)) {
    formData.append('metadata', JSON.stringify(options.metadata));
  }

  if (isPlainObject(options.extraFields)) {
    Object.entries(options.extraFields).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      formData.append(key, String(value));
    });
  }

  return formData;
}

function extractUploadResult(payload) {
  if (!isPlainObject(payload)) {
    throw createApiError('La respuesta del upload tiene un formato inválido.', {
      code: 'INVALID_UPLOAD_FORMAT',
      payload,
    });
  }

  if (isPlainObject(payload.data)) {
    return payload.data;
  }

  if (isPlainObject(payload.file)) {
    return payload.file;
  }

  if (isPlainObject(payload.upload)) {
    return payload.upload;
  }

  if (isPlainObject(payload.result)) {
    return payload.result;
  }

  return payload;
}

function normalizeUploadResult(result, fallbackFile = null) {
  return {
    id:
      result.id ||
      result.fileId ||
      result.uploadId ||
      result.driveFileId ||
      '',
    name:
      result.name ||
      result.fileName ||
      fallbackFile?.name ||
      '',
    url:
      result.url ||
      result.fileUrl ||
      result.webViewLink ||
      result.webContentLink ||
      '',
    downloadUrl:
      result.downloadUrl ||
      result.webContentLink ||
      result.url ||
      '',
    mimeType:
      result.mimeType ||
      result.type ||
      fallbackFile?.type ||
      '',
    size:
      Number(result.size ?? result.fileSize ?? fallbackFile?.size ?? 0) || 0,
    folder:
      result.folder ||
      result.folderName ||
      '',
    raw: result,
  };
}

/**
 * Sube un archivo al endpoint configurado.
 * Pensado para Apps Script usando FormData.
 *
 * @param {File} file
 * @param {Object} options
 * @returns {Promise<Object>} resultado normalizado del upload
 */
export async function uploadFile(file, options = {}) {
  const endpoint = resolveUploadEndpoint();
  const formData = buildUploadFormData(file, options);

  const payload = await requestJson(endpoint, {
    method: options.method || 'POST',
    timeoutMs: options.timeoutMs,
    body: formData,
    headers: options.headers,
  });

  const result = extractUploadResult(payload);

  if (!isPlainObject(result)) {
    throw createApiError('El servidor respondió, pero no devolvió un resultado de upload válido.', {
      code: 'INVALID_UPLOAD_RESULT',
      payload,
    });
  }

  return normalizeUploadResult(result, file);
}

/**
 * Sube varios archivos secuencialmente.
 * Lo hago secuencial para no reventar Apps Script a la primera emoción humana.
 *
 * @param {File[]} files
 * @param {Object} options
 * @returns {Promise<Object[]>}
 */
export async function uploadFiles(files = [], options = {}) {
  if (!Array.isArray(files)) {
    throw createApiError('La lista de archivos no es válida.', {
      code: 'INVALID_FILES_LIST',
    });
  }

  const validFiles = files.filter(Boolean);

  if (validFiles.length === 0) {
    return [];
  }

  const results = [];

  for (const file of validFiles) {
    const uploaded = await uploadFile(file, options);
    results.push(uploaded);
  }

  return results;
}

/**
 * Prepara una carga sin ejecutarla aún.
 * Útil si después desde form.ui.js o process.ui.js quieren inspeccionar el FormData
 * o enganchar otro flujo.
 */
export function createUploadPayload(file, options = {}) {
  const formData = buildUploadFormData(file, options);

  return {
    endpoint: resolveUploadEndpoint(),
    method: options.method || 'POST',
    formData,
  };
}

export default {
  uploadFile,
  uploadFiles,
  createUploadPayload,
};
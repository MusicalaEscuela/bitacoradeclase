// js/utils/helpers.js

import { FILE_LIMITS } from './constants.js';
import { cleanText, toDate } from './format.js';

/* ==========================================================================
   TYPE / SAFETY
   ========================================================================== */

export function isNil(value) {
  return value === null || value === undefined;
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

export function isArray(value) {
  return Array.isArray(value);
}

export function isFunction(value) {
  return typeof value === 'function';
}

export function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isBoolean(value) {
  return typeof value === 'boolean';
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && cleanText(value).length > 0;
}

export function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function safeObject(value) {
  return isPlainObject(value) ? value : {};
}

export function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = cleanText(value).toLowerCase();
    return ['true', '1', 'yes', 'si', 'sí'].includes(normalized);
  }
  return Boolean(value);
}

/* ==========================================================================
   IDS / KEYS
   ========================================================================== */

export function isValidId(value) {
  const id = cleanText(value);
  return id.length >= 2;
}

export function ensureId(value, fallback = '') {
  return isValidId(value) ? cleanText(value) : fallback;
}

export function createTempId(prefix = 'tmp') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ==========================================================================
   COLLECTION HELPERS
   ========================================================================== */

export function clamp(value, min = 0, max = 100) {
  const num = toNumber(value, min);
  return Math.min(Math.max(num, min), max);
}

export function unique(array = []) {
  return [...new Set(safeArray(array))];
}

export function uniqueBy(array = [], keyOrGetter = 'id') {
  const list = safeArray(array);
  const getter = isFunction(keyOrGetter)
    ? keyOrGetter
    : (item) => item?.[keyOrGetter];

  const seen = new Set();

  return list.filter((item) => {
    const key = getter(item);
    if (isNil(key) || key === '') return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function compact(array = []) {
  return safeArray(array).filter(Boolean);
}

export function chunk(array = [], size = 10) {
  const list = safeArray(array);
  const chunkSize = Math.max(1, toNumber(size, 10));
  const result = [];

  for (let i = 0; i < list.length; i += chunkSize) {
    result.push(list.slice(i, i + chunkSize));
  }

  return result;
}

export function flatten(array = []) {
  return safeArray(array).flat(Infinity);
}

export function groupBy(array = [], keyOrGetter = 'id') {
  const list = safeArray(array);
  const getter = isFunction(keyOrGetter)
    ? keyOrGetter
    : (item) => item?.[keyOrGetter];

  return list.reduce((acc, item) => {
    const key = getter(item);
    const groupKey = isNil(key) || key === '' ? 'unknown' : String(key);

    if (!acc[groupKey]) {
      acc[groupKey] = [];
    }

    acc[groupKey].push(item);
    return acc;
  }, {});
}

export function indexBy(array = [], keyOrGetter = 'id') {
  const list = safeArray(array);
  const getter = isFunction(keyOrGetter)
    ? keyOrGetter
    : (item) => item?.[keyOrGetter];

  return list.reduce((acc, item) => {
    const key = getter(item);
    if (!isNil(key) && key !== '') {
      acc[String(key)] = item;
    }
    return acc;
  }, {});
}

export function sortBy(array = [], getter, direction = 'asc') {
  const list = [...safeArray(array)];
  const factor = direction === 'desc' ? -1 : 1;

  return list.sort((a, b) => {
    const aValue = isFunction(getter) ? getter(a) : a?.[getter];
    const bValue = isFunction(getter) ? getter(b) : b?.[getter];

    if (aValue === bValue) return 0;
    if (aValue === undefined || aValue === null) return 1;
    if (bValue === undefined || bValue === null) return -1;

    if (typeof aValue === 'string' && typeof bValue === 'string') {
      return aValue.localeCompare(bValue, 'es', { sensitivity: 'base' }) * factor;
    }

    return (aValue > bValue ? 1 : -1) * factor;
  });
}

export function sortByDateDesc(array = [], keyOrGetter = 'createdAt') {
  const list = [...safeArray(array)];
  const getter = isFunction(keyOrGetter)
    ? keyOrGetter
    : (item) => item?.[keyOrGetter];

  return list.sort((a, b) => {
    const aDate = toDate(getter(a));
    const bDate = toDate(getter(b));

    const aTime = aDate ? aDate.getTime() : 0;
    const bTime = bDate ? bDate.getTime() : 0;

    return bTime - aTime;
  });
}

export function sortByDateAsc(array = [], keyOrGetter = 'createdAt') {
  const list = [...safeArray(array)];
  const getter = isFunction(keyOrGetter)
    ? keyOrGetter
    : (item) => item?.[keyOrGetter];

  return list.sort((a, b) => {
    const aDate = toDate(getter(a));
    const bDate = toDate(getter(b));

    const aTime = aDate ? aDate.getTime() : 0;
    const bTime = bDate ? bDate.getTime() : 0;

    return aTime - bTime;
  });
}

/* ==========================================================================
   OBJECT HELPERS
   ========================================================================== */

export function pick(object = {}, keys = []) {
  const source = safeObject(object);
  const result = {};

  safeArray(keys).forEach((key) => {
    if (key in source) {
      result[key] = source[key];
    }
  });

  return result;
}

export function omit(object = {}, keys = []) {
  const source = safeObject(object);
  const keysToOmit = new Set(safeArray(keys));

  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !keysToOmit.has(key))
  );
}

export function omitEmpty(object = {}) {
  const source = safeObject(object);

  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => {
      if (isNil(value)) return false;
      if (typeof value === 'string' && cleanText(value) === '') return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return true;
    })
  );
}

export function mergeObjects(...objects) {
  return objects.reduce((acc, current) => {
    return { ...acc, ...safeObject(current) };
  }, {});
}

export function deepMerge(target = {}, source = {}) {
  const base = safeObject(target);
  const incoming = safeObject(source);

  const result = { ...base };

  Object.keys(incoming).forEach((key) => {
    const baseValue = base[key];
    const incomingValue = incoming[key];

    if (isPlainObject(baseValue) && isPlainObject(incomingValue)) {
      result[key] = deepMerge(baseValue, incomingValue);
    } else {
      result[key] = incomingValue;
    }
  });

  return result;
}

/* ==========================================================================
   SEARCH
   ========================================================================== */

export function normalizeSearchText(value = '') {
  return cleanText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function buildSearchText(...values) {
  return values
    .flat(Infinity)
    .map((value) => {
      if (Array.isArray(value)) return value.join(' ');
      if (isPlainObject(value)) return Object.values(value).join(' ');
      return String(value ?? '');
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function matchesSearch(item, query, fields = []) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;

  let text = '';

  if (isNonEmptyString(item)) {
    text = item;
  } else if (isPlainObject(item)) {
    if (fields.length > 0) {
      text = fields.map((field) => item?.[field] ?? '').join(' ');
    } else if (item.searchText) {
      text = item.searchText;
    } else {
      text = Object.values(item).join(' ');
    }
  } else {
    text = String(item ?? '');
  }

  return normalizeSearchText(text).includes(normalizedQuery);
}

export function filterBySearch(array = [], query = '', fields = []) {
  return safeArray(array).filter((item) => matchesSearch(item, query, fields));
}

/* ==========================================================================
   DATE / TIME
   ========================================================================== */

export function nowIso() {
  return new Date().toISOString();
}

export function nowTimestamp() {
  return Date.now();
}

export function isDateInRange(value, start, end) {
  const date = toDate(value);
  if (!date) return false;

  const target = date.getTime();
  const startDate = start ? toDate(start)?.getTime() : null;
  const endDate = end ? toDate(end)?.getTime() : null;

  if (startDate && target < startDate) return false;
  if (endDate && target > endDate) return false;

  return true;
}

/* ==========================================================================
   FILES
   ========================================================================== */

export function getFileExtension(filename = '') {
  const name = cleanText(filename);
  if (!name.includes('.')) return '';
  return name.split('.').pop().toLowerCase();
}

export function getFileType(file = {}) {
  const mimeType = cleanText(file?.type).toLowerCase();
  const extension = getFileExtension(file?.name || '');

  if (mimeType.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(extension)) {
    return 'image';
  }

  if (mimeType.startsWith('video/') || ['mp4', 'mov', 'webm', 'm4v'].includes(extension)) {
    return 'video';
  }

  if (['pdf', 'doc', 'docx', 'txt'].includes(extension)) {
    return 'document';
  }

  return 'other';
}

export function isValidFileSize(file, maxSize = FILE_LIMITS.MAX_FILE_SIZE_BYTES) {
  const size = toNumber(file?.size, 0);
  return size > 0 && size <= maxSize;
}

export function getFilesTotalSize(files = []) {
  return safeArray(files).reduce((total, file) => {
    return total + toNumber(file?.size, 0);
  }, 0);
}

export function isValidFilesBatch(
  files = [],
  {
    maxFiles = FILE_LIMITS.MAX_FILES,
    maxFileSize = FILE_LIMITS.MAX_FILE_SIZE_BYTES,
    maxTotalSize = FILE_LIMITS.MAX_TOTAL_SIZE_BYTES
  } = {}
) {
  const list = safeArray(files);

  if (list.length === 0) {
    return { valid: true, reason: '' };
  }

  if (list.length > maxFiles) {
    return { valid: false, reason: 'max_files' };
  }

  if (list.some((file) => !isValidFileSize(file, maxFileSize))) {
    return { valid: false, reason: 'max_file_size' };
  }

  if (getFilesTotalSize(list) > maxTotalSize) {
    return { valid: false, reason: 'max_total_size' };
  }

  return { valid: true, reason: '' };
}

/* ==========================================================================
   ASYNC / EVENTS
   ========================================================================== */

export function debounce(fn, wait = 250) {
  let timeoutId = null;

  return function debounced(...args) {
    const context = this;
    clearTimeout(timeoutId);

    timeoutId = setTimeout(() => {
      fn.apply(context, args);
    }, wait);
  };
}

export function throttle(fn, wait = 250) {
  let lastTime = 0;
  let timeoutId = null;

  return function throttled(...args) {
    const now = Date.now();
    const remaining = wait - (now - lastTime);
    const context = this;

    if (remaining <= 0) {
      clearTimeout(timeoutId);
      timeoutId = null;
      lastTime = now;
      fn.apply(context, args);
      return;
    }

    if (!timeoutId) {
      timeoutId = setTimeout(() => {
        lastTime = Date.now();
        timeoutId = null;
        fn.apply(context, args);
      }, remaining);
    }
  };
}

export function wait(ms = 0) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/* ==========================================================================
   ARRAY / PAGINATION
   ========================================================================== */

export function paginate(array = [], page = 1, pageSize = 10) {
  const list = safeArray(array);
  const currentPage = Math.max(1, toNumber(page, 1));
  const size = Math.max(1, toNumber(pageSize, 10));

  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const start = (currentPage - 1) * size;
  const end = start + size;

  return {
    items: list.slice(start, end),
    page: currentPage,
    pageSize: size,
    total,
    totalPages,
    hasPrev: currentPage > 1,
    hasNext: currentPage < totalPages
  };
}

/* ==========================================================================
   NORMALIZACIÓN LIGERA
   ========================================================================== */

export function normalizeString(value = '', fallback = '') {
  return isNonEmptyString(value) ? cleanText(value) : fallback;
}

export function normalizeArray(value = [], mapper = null) {
  const list = safeArray(value);
  return isFunction(mapper) ? list.map(mapper) : list;
}

export function normalizeObject(value = {}, defaults = {}) {
  return {
    ...safeObject(defaults),
    ...safeObject(value)
  };
}
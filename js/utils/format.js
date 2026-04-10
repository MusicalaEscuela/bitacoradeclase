// js/utils/format.js

import {
  STATUS_LABELS,
  TYPE_LABELS,
  TEXT_LIMITS,
  FILE_LIMITS
} from './constants.js';

/* ==========================================================================
   BASE
   ========================================================================== */

export function cleanText(value = '') {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function capitalize(value = '') {
  const text = cleanText(value);
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function capitalizeWords(value = '') {
  return cleanText(value)
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((word) => capitalize(word))
    .join(' ');
}

export function normalizeVisibleName(value = '') {
  return capitalizeWords(value);
}

export function toLowerSafe(value = '') {
  return cleanText(value).toLowerCase();
}

/* ==========================================================================
   LABELS
   ========================================================================== */

export function formatStatusLabel(status = '') {
  const key = cleanText(status).toLowerCase();
  return STATUS_LABELS[key] || capitalizeWords(key || 'sin estado');
}

export function formatTypeLabel(type = '') {
  const key = cleanText(type).toLowerCase();
  return TYPE_LABELS[key] || capitalizeWords(key || 'general');
}

/* ==========================================================================
   FECHAS / HORAS
   ========================================================================== */

export function toDate(value) {
  if (!value) return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === 'string') {
    const text = cleanText(value);

    if (!text) return null;

    // ISO o parseable nativo
    const nativeDate = new Date(text);
    if (!Number.isNaN(nativeDate.getTime())) {
      return nativeDate;
    }

    // dd/mm/yyyy o dd-mm-yyyy
    const match = text.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (match) {
      const [, d, m, y] = match;
      const year = y.length === 2 ? `20${y}` : y;
      const parsed = new Date(Number(year), Number(m) - 1, Number(d));
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
  }

  if (typeof value === 'object') {
    // Firestore / objetos raros con seconds
    if (typeof value.seconds === 'number') {
      const date = new Date(value.seconds * 1000);
      return Number.isNaN(date.getTime()) ? null : date;
    }

    // Apps Script / serializado con date
    if (value.date) {
      return toDate(value.date);
    }
  }

  return null;
}

export function isValidDate(value) {
  return toDate(value) instanceof Date;
}

export function formatDate(value, locale = 'es-CO') {
  const date = toDate(value);
  if (!date) return '—';

  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(date);
}

export function formatDateShort(value, locale = 'es-CO') {
  const date = toDate(value);
  if (!date) return '—';

  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: '2-digit'
  }).format(date);
}

export function formatDateLong(value, locale = 'es-CO') {
  const date = toDate(value);
  if (!date) return '—';

  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(date);
}

export function formatTime(value, locale = 'es-CO') {
  const date = toDate(value);
  if (!date) return '—';

  return new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
}

export function formatDateTime(value, locale = 'es-CO') {
  const date = toDate(value);
  if (!date) return '—';

  return `${formatDate(date, locale)} · ${formatTime(date, locale)}`;
}

export function formatDateForInput(value) {
  const date = toDate(value);
  if (!date) return '';

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

export function formatDateTimeForInput(value) {
  const date = toDate(value);
  if (!date) return '';

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');

  return `${year}-${month}-${day}T${hour}:${minute}`;
}

export function formatRelativeDate(value, locale = 'es-CO') {
  const date = toDate(value);
  if (!date) return '—';

  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffMinutes = Math.round(diffMs / (1000 * 60));
  const diffHours = Math.round(diffMinutes / 60);
  const diffDays = Math.round(diffHours / 24);

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  if (Math.abs(diffMinutes) < 60) {
    return rtf.format(diffMinutes, 'minute');
  }

  if (Math.abs(diffHours) < 24) {
    return rtf.format(diffHours, 'hour');
  }

  return rtf.format(diffDays, 'day');
}

/* ==========================================================================
   TEXTO / CONTENIDO
   ========================================================================== */

export function formatExcerpt(value = '', maxLength = TEXT_LIMITS.EXCERPT_LENGTH) {
  const text = cleanText(value);

  if (!text) return '';
  if (text.length <= maxLength) return text;

  return `${text.slice(0, maxLength).trimEnd()}…`;
}

export function formatMultilineText(value = '') {
  return cleanText(value)
    .replace(/\. (?=[A-ZÁÉÍÓÚÑ])/g, '.\n');
}

export function formatInitials(value = '') {
  const text = cleanText(value);
  if (!text) return '';

  const parts = text.split(' ').filter(Boolean);
  const initials = parts.slice(0, 2).map((part) => part.charAt(0).toUpperCase());

  return initials.join('');
}

export function formatTags(tags = []) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((tag) => cleanText(tag))
    .filter(Boolean)
    .map((tag) => capitalizeWords(tag));
}

/* ==========================================================================
   ARCHIVOS
   ========================================================================== */

export function formatBytes(bytes = 0, decimals = 1) {
  const value = Number(bytes);

  if (!Number.isFinite(value) || value <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1
  );

  const size = value / Math.pow(1024, index);
  return `${size.toFixed(index === 0 ? 0 : decimals)} ${units[index]}`;
}

export function formatFileSize(bytes = 0) {
  return formatBytes(bytes);
}

export function formatFileCount(count = 0) {
  const value = Number(count) || 0;
  return value === 1 ? '1 archivo' : `${value} archivos`;
}

export function formatFileLimitLabel() {
  return `${FILE_LIMITS.MAX_FILES} archivos · ${FILE_LIMITS.MAX_FILE_SIZE_MB} MB máx. c/u`;
}

export function getFileExtension(filename = '') {
  const text = cleanText(filename);
  if (!text.includes('.')) return '';

  return text.split('.').pop().toLowerCase();
}

export function formatFileName(filename = '') {
  return cleanText(filename);
}

/* ==========================================================================
   BÚSQUEDA / PRESENTACIÓN
   ========================================================================== */

export function formatSearchQuery(value = '') {
  return cleanText(value).slice(0, TEXT_LIMITS.SEARCH_MAX);
}

export function formatStudentName(student = {}) {
  if (!student || typeof student !== 'object') return '';

  const fullName =
    student.fullName ||
    student.name ||
    [student.firstName, student.lastName].filter(Boolean).join(' ');

  return normalizeVisibleName(fullName);
}

export function formatStudentSubtitle(student = {}) {
  if (!student || typeof student !== 'object') return '';

  const parts = [
    student.instrument,
    student.modality,
    student.program,
    student.level
  ]
    .map((item) => cleanText(item))
    .filter(Boolean);

  return parts.join(' · ');
}

export function formatBitacoraTitle(bitacora = {}) {
  if (!bitacora || typeof bitacora !== 'object') return '';

  const title = cleanText(bitacora.title);
  if (title) return title;

  const typeLabel = formatTypeLabel(bitacora.type);
  const dateLabel = bitacora.createdAt ? formatDateShort(bitacora.createdAt) : '';

  return [typeLabel, dateLabel].filter(Boolean).join(' · ');
}

export function formatBitacoraMeta(bitacora = {}) {
  if (!bitacora || typeof bitacora !== 'object') return '';

  const parts = [
    formatTypeLabel(bitacora.type),
    bitacora.author ? normalizeVisibleName(bitacora.author) : '',
    bitacora.createdAt ? formatDateTime(bitacora.createdAt) : ''
  ].filter(Boolean);

  return parts.join(' · ');
}

/* ==========================================================================
   FALLBACKS / DISPLAY
   ========================================================================== */

export function displayValue(value, fallback = '—') {
  const text = cleanText(value);
  return text || fallback;
}

export function displayNumber(value, fallback = '—') {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : fallback;
}
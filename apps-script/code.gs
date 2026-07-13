/*******************************************************
 * API Bitacoras Musicala
 * Lectura de estudiantes y procesos
 * Proyecto independiente
 *******************************************************/

const CONFIG = {
  SPREADSHEET_ID: "1MsWABlj_LdhWKzVq_u-1M6S5zEJ2yQ72oiusvzzQZAI",

  STUDENTS_SHEET_NAME: "Inscripcion estudiantes",
  STUDENTS_SHEET_CANDIDATES: [
    "Inscripcion estudiantes",
    "Inscripción estudiantes",
    "Estudiantes",
    "students",
  ],

  HEADER_ROW: 1,
  DATA_START_ROW: 2,
  TIMEZONE: "America/Bogota",

  // Correo que recibe alertas cuando falla la sincronizacion automatica.
  ALERT_EMAIL: "alekcaballeromusic@gmail.com",

  // Minutos minimos entre sincronizaciones disparadas via ?action=sync.
  // Evita que cada apertura de la app dispare una corrida completa.
  SYNC_MIN_INTERVAL_MINUTES: 5,

  // El trigger horario procesa una porcion estable de la hoja. El presupuesto
  // deja 30 segundos para persistir cursor y reporte antes del limite duro.
  SYNC_BATCH_MAX_ROWS: 40,
  SYNC_BUDGET_MS: 240000,
  SYNC_SAFETY_MARGIN_MS: 30000,

  COLS: {
    NOMBRE: 1,
    ESTADO: 2,
    EDAD: 5,
    EMAIL: 8,
    CURSO: 12,
    INSTRUMENTO: 13,
    ESTILO: 14,
    ENFASIS: 15,
    INTERESES: 16,
  },
};

/* =====================================================
 * ENTRYPOINTS
 * ===================================================== */

function doGet(e) {
  try {
    const params = e && e.parameter ? e.parameter : {};
    const action = String(params.action || "students").trim().toLowerCase();

    let payload;

    switch (action) {
      case "health":
        payload = {
          ok: true,
          message: "API Bitacoras Musicala activa",
          timestamp: new Date().toISOString(),
          availableActions: ["health", "students", "student", "processes", "teachers", "sync"],
          deprecatedActions: ["teachers"],
          timezone: CONFIG.TIMEZONE,
        };
        break;

      case "students":
        payload = handleGetStudents_(params);
        break;

      case "student":
        payload = handleGetStudent_(params);
        break;

      case "processes":
        payload = handleGetProcesses_(params);
        break;

      case "teachers":
        payload = handleGetTeachers_(params);
        break;

      case "sync":
        payload = handleTriggerSync_(params);
        break;

      default:
        payload = {
          ok: false,
          error: 'Accion no valida: "' + action + '"',
          availableActions: ["health", "students", "student", "processes", "teachers", "sync"],
          deprecatedActions: ["teachers"],
        };
        break;
    }

    return jsonOutput_(payload);
  } catch (error) {
    return jsonOutput_({
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
}

/* =====================================================
 * ACTION HANDLERS
 * ===================================================== */

function handleGetStudents_(params) {
  const q = normalizeText_(params.q || params.query || params.search || "");
  const estado = normalizeText_(params.estado || "activo");
  const arte = normalizeText_(params.arte || params.area || "");
  const includeInactive = toBoolean_(params.includeInactive, false);

  const rows = getStudentRows_();
  const students = [];

  rows.forEach(function (rowObj) {
    const student = mapRowToStudent_(rowObj);
    if (!student) return;

    if (!includeInactive) {
      if (!isActiveStatus_(student.estado)) return;
    } else if (estado && estado !== "todos" && normalizeText_(student.estado) !== estado) {
      return;
    }

    if (q) {
      const hayMatch =
        normalizeText_(student.nombre).indexOf(q) !== -1 ||
        normalizeText_(student.interesesMusicales).indexOf(q) !== -1 ||
        student.processes.some(function (p) {
          return (
            normalizeText_(p.arte).indexOf(q) !== -1 ||
            normalizeText_(p.detalle).indexOf(q) !== -1 ||
            normalizeText_(p.label).indexOf(q) !== -1
          );
        });

      if (!hayMatch) return;
    }

    if (arte) {
      const filteredProcesses = student.processes.filter(function (p) {
        return normalizeText_(p.arte) === arte;
      });

      if (!filteredProcesses.length) return;
      student.processes = filteredProcesses;
    }

    students.push(student);
  });

  students.sort(function (a, b) {
    return a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" });
  });

  return {
    ok: true,
    total: students.length,
    data: students,
    students: students,
  };
}

function handleGetStudent_(params) {
  const studentKey = String(params.studentKey || params.id || "").trim();
  const email = String(params.email || params.correo || "").trim().toLowerCase();

  if (!studentKey && !email) {
    return {
      ok: false,
      error: "Falta studentKey o email",
    };
  }

  const rows = getStudentRows_();
  const students = rows.map(mapRowToStudent_).filter(Boolean);

  const student = students.find(function (item) {
    if (studentKey && item.studentKey === studentKey) return true;

    if (email) {
      const candidates = (Array.isArray(item.emails) ? item.emails : [])
        .concat([
          item.email,
          item.correo,
          item.correoElectronico,
        ])
        .map(function (value) {
          return String(value || "").trim().toLowerCase();
        })
        .filter(Boolean);

      return candidates.indexOf(email) !== -1;
    }

    return false;
  });

  if (!student) {
    if (email) {
      return {
        ok: true,
        data: null,
        student: null,
        profile: null,
        result: null,
      };
    }

    return {
      ok: false,
      error: "Estudiante no encontrado",
    };
  }

  return {
    ok: true,
    data: student,
    student: student,
    profile: student,
    result: student,
  };
}

function handleGetProcesses_(params) {
  const q = normalizeText_(params.q || params.query || params.search || "");
  const estado = normalizeText_(params.estado || "activo");
  const arte = normalizeText_(params.arte || params.area || "");
  const includeInactive = toBoolean_(params.includeInactive, false);

  const rows = getStudentRows_();
  const processes = [];

  rows.forEach(function (rowObj) {
    const student = mapRowToStudent_(rowObj);
    if (!student) return;

    if (!includeInactive) {
      if (!isActiveStatus_(student.estado)) return;
    } else if (estado && estado !== "todos" && normalizeText_(student.estado) !== estado) {
      return;
    }

    student.processes.forEach(function (process) {
      if (arte && normalizeText_(process.arte) !== arte) return;

      if (q) {
        const hayMatch =
          normalizeText_(student.nombre).indexOf(q) !== -1 ||
          normalizeText_(student.interesesMusicales).indexOf(q) !== -1 ||
          normalizeText_(process.arte).indexOf(q) !== -1 ||
          normalizeText_(process.detalle).indexOf(q) !== -1 ||
          normalizeText_(process.label).indexOf(q) !== -1;

        if (!hayMatch) return;
      }

      processes.push({
        processKey: process.processKey,
        studentKey: student.studentKey,
        nombre: student.nombre,
        estado: student.estado,
        edad: student.edad,
        interesesMusicales: student.interesesMusicales,
        arte: process.arte,
        detalle: process.detalle,
        label: process.label,
        sourceRow: student.sourceRow,
      });
    });
  });

  processes.sort(function (a, b) {
    const byName = a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" });
    if (byName !== 0) return byName;
    return a.label.localeCompare(b.label, "es", { sensitivity: "base" });
  });

  return {
    ok: true,
    total: processes.length,
    data: processes,
    results: processes,
  };
}

/**
 * Sincronizacion bajo demanda: la app de Bitacoras la dispara cuando un
 * admin abre la app (GET ?action=sync&source=app_open). Con throttle para
 * que aperturas seguidas no encolen corridas: si la ultima sincronizacion
 * fue hace menos de SYNC_MIN_INTERVAL_MINUTES, responde "skipped".
 * Usa ?force=true para saltarse el throttle (depuracion).
 */
function handleTriggerSync_(params) {
  const force = toBoolean_(params.force, false);
  const source = String(params.source || "manual").trim();
  const props = PropertiesService.getScriptProperties();
  const lastSyncAt = Number(props.getProperty("LAST_ONDEMAND_SYNC_AT") || 0);
  const minIntervalMs = CONFIG.SYNC_MIN_INTERVAL_MINUTES * 60 * 1000;
  const now = Date.now();

  if (!force && lastSyncAt && now - lastSyncAt < minIntervalMs) {
    return {
      ok: true,
      skipped: true,
      reason: "Sincronizacion reciente, no se repite todavia.",
      lastSyncAt: new Date(lastSyncAt).toISOString(),
      nextAllowedAt: new Date(lastSyncAt + minIntervalMs).toISOString(),
      source: source,
    };
  }

  try {
    const report = syncAllSheetsToFirestore();
    props.setProperty("LAST_ONDEMAND_SYNC_AT", String(now));

    return {
      ok: true,
      skipped: false,
      source: source,
      report: report,
    };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);

    // Otra corrida en curso (lock ocupado) no es un fallo para quien abre la app.
    if (message.indexOf("sincronizacion de estudiantes en curso") !== -1) {
      return {
        ok: true,
        skipped: true,
        reason: "Ya hay una sincronizacion en curso.",
        source: source,
      };
    }

    return {
      ok: false,
      error: message,
      source: source,
    };
  }
}

function handleGetTeachers_() {
  return {
    ok: true,
    total: 0,
    data: [],
    teachers: [],
    results: [],
    message: "Los docentes ya no se consultan desde Apps Script. Usa Firebase/catalogos.",
    deprecated: true,
  };
}

/* =====================================================
 * CORE DATA
 * ===================================================== */

function getSpreadsheet_() {
  return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
}

function getSheetByCandidates_(primaryName, candidates) {
  const ss = getSpreadsheet_();

  if (primaryName) {
    const exact = ss.getSheetByName(primaryName);
    if (exact) return exact;
  }

  const normalizedCandidates = (candidates || []).map(normalizeText_);
  const sheets = ss.getSheets();

  for (let i = 0; i < sheets.length; i += 1) {
    const sheet = sheets[i];
    if (normalizedCandidates.indexOf(normalizeText_(sheet.getName())) !== -1) {
      return sheet;
    }
  }

  throw new Error(
    'No se encontro la pestaña "' +
      primaryName +
      '"' +
      (normalizedCandidates.length
        ? ". Candidatas: " + normalizedCandidates.join(", ")
        : "")
  );
}

function getSheetRows_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  if (lastRow < CONFIG.DATA_START_ROW || lastCol < 1) return [];

  const range = sheet.getRange(
    CONFIG.DATA_START_ROW,
    1,
    lastRow - CONFIG.HEADER_ROW,
    lastCol
  );

  return range.getValues().map(function (row, index) {
    return {
      rowNumber: CONFIG.DATA_START_ROW + index,
      values: row,
    };
  });
}

function getStudentRows_() {
  const sheet = getSheetByCandidates_(
    CONFIG.STUDENTS_SHEET_NAME,
    CONFIG.STUDENTS_SHEET_CANDIDATES
  );
  return getSheetRows_(sheet);
}

/* =====================================================
 * MAPPERS
 * ===================================================== */

function mapRowToStudent_(rowObj) {
  const row = rowObj.values;

  const nombre = safeCell_(row, CONFIG.COLS.NOMBRE);
  const estado = safeCell_(row, CONFIG.COLS.ESTADO);
  const edadRaw = safeCell_(row, CONFIG.COLS.EDAD);
  // La celda puede traer varios correos (acudiente y estudiante) separados
  // por coma, espacio o salto de linea: todos dan acceso al HUB.
  const emails = extractEmails_(safeCell_(row, CONFIG.COLS.EMAIL));
  const email = emails.length ? emails[0] : "";
  const cursoRaw = safeCell_(row, CONFIG.COLS.CURSO);
  const instrumento = safeCell_(row, CONFIG.COLS.INSTRUMENTO);
  const estilo = safeCell_(row, CONFIG.COLS.ESTILO);
  const enfasis = safeCell_(row, CONFIG.COLS.ENFASIS);
  const intereses = safeCell_(row, CONFIG.COLS.INTERESES);

  if (!nombre) return null;

  const processes = buildProcesses_(
    nombre,
    cursoRaw,
    instrumento,
    estilo,
    enfasis,
    rowObj.rowNumber
  );

  return {
    studentKey: buildStudentKey_(nombre, rowObj.rowNumber),
    id: buildStudentKey_(nombre, rowObj.rowNumber),
    nombre: nombre,
    name: nombre,
    estado: estado || "",
    edad: parseAge_(edadRaw),
    email: email,
    correo: email,
    correoElectronico: email,
    emails: emails,
    interesesMusicales: intereses || "",
    intereses: intereses || "",
    processes: processes,
    sourceRow: rowObj.rowNumber,
  };
}

/* =====================================================
 * STUDENT PROCESSES
 * ===================================================== */

function buildProcesses_(nombre, cursoRaw, instrumento, estilo, enfasis, rowNumber) {
  const cursos = splitCursos_(cursoRaw);
  const processes = [];

  cursos.forEach(function (curso) {
    const cursoNorm = normalizeCourse_(curso);
    if (!cursoNorm) return;

    let detalles = [];

    if (cursoNorm === "MÚSICA") {
      detalles = splitProcessDetails_(instrumento, "Sin instrumento");
    }
    if (cursoNorm === "BAILE") {
      detalles = splitProcessDetails_(estilo, "Sin estilo");
    }
    if (cursoNorm === "ARTES PLÁSTICAS") {
      detalles = splitProcessDetails_(enfasis, "Sin enfasis");
    }

    if (!detalles.length) {
      detalles = [""];
    }

    detalles.forEach(function (detalle) {
      const processKey = buildProcessKey_(nombre, cursoNorm, detalle, rowNumber);

      processes.push({
        processKey: processKey,
        arte: cursoNorm,
        detalle: detalle,
        label: cursoNorm + " - " + detalle,
      });
    });
  });

  return dedupeProcesses_(processes);
}

/* =====================================================
 * HELPERS
 * ===================================================== */

function safeCell_(row, colNumber) {
  const value = row[colNumber - 1];
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function parseAge_(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return isNaN(n) ? String(value).trim() : n;
}

function parseNumberOrNull_(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return isNaN(n) ? null : n;
}

function isFiniteNumber_(value) {
  return typeof value === "number" && isFinite(value);
}

function splitCursos_(cursoRaw) {
  const text = String(cursoRaw || "").trim();
  if (!text) return [];

  return text
    .split(/,|;|\n|\//g)
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean);
}

function splitProcessDetails_(rawValue, fallback) {
  const text = String(rawValue || "").trim();

  if (!text) {
    return [fallback];
  }

  const values = text
    .split(/,|;|\n/g)
    .map(function (s) {
      return String(s || "").trim();
    })
    .filter(Boolean);

  if (!values.length) {
    return [fallback];
  }

  const deduped = {};
  values.forEach(function (value) {
    deduped[value] = true;
  });

  return Object.keys(deduped);
}

function normalizeCourse_(text) {
  const t = normalizeText_(text);

  if (!t) return "";

  if (t.indexOf("musica") !== -1) return "MÚSICA";
  if (t.indexOf("baile") !== -1 || t.indexOf("danza") !== -1) return "BAILE";
  if (t.indexOf("plast") !== -1) return "ARTES PLÁSTICAS";

  return String(text || "").trim().toUpperCase();
}

function normalizeText_(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function slugify_(text) {
  return normalizeText_(text)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildStudentKey_(nombre, rowNumber) {
  return "stu_" + slugify_(nombre) + "_" + rowNumber;
}

function buildProcessKey_(nombre, arte, detalle, rowNumber) {
  return (
    "proc_" +
    slugify_(nombre) +
    "_" +
    slugify_(arte) +
    "_" +
    slugify_(detalle) +
    "_" +
    rowNumber
  );
}

function dedupeProcesses_(processes) {
  const map = {};
  processes.forEach(function (p) {
    map[p.processKey] = p;
  });
  return Object.keys(map).map(function (k) {
    return map[k];
  });
}

function isActiveStatus_(estado) {
  const e = normalizeText_(estado);
  if (!e) return true;

  return (
    e === "activo" ||
    e === "activa" ||
    e === "en proceso" ||
    e === "vigente" ||
    e.indexOf("activo ") === 0
  );
}

function toBoolean_(value, defaultValue) {
  if (value === true || value === false) return value;
  const v = String(value || "").trim().toLowerCase();
  if (!v) return defaultValue;
  return ["1", "true", "si", "sí", "yes"].indexOf(v) !== -1;
}

/* =====================================================
 * FIRESTORE SYNC
 * ===================================================== */

function syncAllSheetsToFirestore() {
  const lock = LockService.getScriptLock();
  const startedAtMs = Date.now();
  let cursorBefore = emptySyncCursor_("idle");
  let report = createBatchSyncReport_("", cursorBefore, startedAtMs);

  if (!lock.tryLock(1000)) {
    report.status = "failed";
    report.errors = 1;
    report.errorCode = "LOCK_BUSY";
    report.durationMs = Date.now() - startedAtMs;
    saveSyncBatchReport_(report);
    return report;
  }

  try {
    const cursorStartedAt = Date.now();
    cursorBefore = normalizeSyncCursor_(loadSyncCursor_());
    if (cursorBefore.cycleState !== "running") {
      cursorBefore = createRunningSyncCursor_();
    }
    report = createBatchSyncReport_(cursorBefore.runId, cursorBefore, startedAtMs);
    report.stages.cursorReadMs = Date.now() - cursorStartedAt;
    report.metrics.firestoreCalls.reads += 1;

    const controlStartedAt = Date.now();
    const control = loadSyncControl_();
    report.stages.controlReadMs = Date.now() - controlStartedAt;
    report.metrics.firestoreCalls.reads += 1;
    const maxRows = effectiveSyncBatchSize_(control, cursorBefore.runId);

    const sheetStartedAt = Date.now();
    const sheet = getStudentSheetForSync_();
    const page = readStudentRowsBatch_(sheet, cursorBefore.nextRow, maxRows);
    report.stages.sheetReadMs = Date.now() - sheetStartedAt;
    report.metrics.sheetReads = page.rows.length ? 1 : 0;

    if (isSyncBudgetReached_(startedAtMs, Date.now(), CONFIG.SYNC_BUDGET_MS, CONFIG.SYNC_SAFETY_MARGIN_MS)) {
      const pausedCursor = runningSyncCursor_(cursorBefore, cursorBefore.sheet, cursorBefore.nextRow);
      saveSyncCursor_(pausedCursor);
      report.metrics.firestoreCalls.writes += 1;
      report.status = "partial";
      report.errorCode = "BUDGET_REACHED_BEFORE_BATCH";
      report.cursorAfter = sanitizeSyncCursor_(pausedCursor);
    } else if (!page.rows.length) {
      const completedCursor = completedSyncCursor_(cursorBefore, page.sheetName);
      saveSyncCursor_(completedCursor);
      report.metrics.firestoreCalls.writes += 1;
      report.status = "completed";
      report.cursorAfter = sanitizeSyncCursor_(completedCursor);
    } else {
      const result = processStudentRowsBatch_(page.rows, startedAtMs);
      report.processed = result.processed;
      report.created = result.created;
      report.updated = result.updated;
      report.noOp = result.noOp;
      report.errors = result.errors;
      report.students = result.students;
      report.users = result.users;
      report.stages.firestoreReadMs = result.firestoreReadMs;
      report.stages.buildMs = result.buildMs;
      report.stages.writeMs = result.writeMs;
      report.metrics.firestoreCalls.reads += result.firestoreReadCalls;
      report.metrics.firestoreCalls.writes += result.firestoreWriteCalls;

      if (result.budgetReached) {
        const pausedCursor = runningSyncCursor_(cursorBefore, cursorBefore.sheet, cursorBefore.nextRow);
        saveSyncCursor_(pausedCursor);
        report.metrics.firestoreCalls.writes += 1;
        report.status = "partial";
        report.errorCode = "BUDGET_REACHED_BEFORE_WRITE";
        report.cursorAfter = sanitizeSyncCursor_(pausedCursor);
      } else {
        const nextRow = page.rows[page.rows.length - 1].rowNumber + 1;
        const cycleCompleted = nextRow > page.lastRow;
        const cursorAfter = cycleCompleted
          ? completedSyncCursor_(cursorBefore, page.sheetName)
          : runningSyncCursor_(cursorBefore, page.sheetName, nextRow);
        const cursorWriteStartedAt = Date.now();
        saveSyncCursor_(cursorAfter);
        report.stages.cursorWriteMs = Date.now() - cursorWriteStartedAt;
        report.metrics.firestoreCalls.writes += 1;
        report.status = cycleCompleted ? "completed" : "partial";
        report.cursorAfter = sanitizeSyncCursor_(cursorAfter);
      }
    }

    if (control && control.once === true &&
        (!control.runId || String(control.runId) === String(cursorBefore.runId))) {
      clearSyncControl_();
      report.metrics.firestoreCalls.writes += 1;
    }

    report.durationMs = Date.now() - startedAtMs;
    // La escritura del propio reporte tambien es una llamada Firestore.
    report.metrics.firestoreCalls.writes += 1;
    saveSyncBatchReport_(report);
    return report;
  } catch (error) {
    report.status = "failed";
    report.errors = Math.max(1, Number(report.errors || 0));
    report.errorCode = safeSyncErrorCode_(error);
    report.cursorAfter = sanitizeSyncCursor_(cursorBefore);
    report.durationMs = Date.now() - startedAtMs;
    report.metrics.firestoreCalls.writes += 1;
    try {
      saveSyncBatchReport_(report);
    } catch (reportError) {
      console.error("SYNC_REPORT_PERSIST_FAILED", safeSyncErrorCode_(reportError));
    }
    throw new Error(report.errorCode);
  } finally {
    lock.releaseLock();
  }
}

function emptySyncCursor_(cycleState) {
  return {
    sheet: CONFIG.STUDENTS_SHEET_NAME,
    nextRow: CONFIG.DATA_START_ROW,
    runId: "",
    updatedAt: new Date().toISOString(),
    cycleState: String(cycleState || "idle"),
  };
}

function normalizeSyncCursor_(value) {
  const source = value && typeof value === "object" ? value : {};
  const nextRow = Math.max(CONFIG.DATA_START_ROW, Number(source.nextRow || CONFIG.DATA_START_ROW));
  return {
    sheet: String(source.sheet || CONFIG.STUDENTS_SHEET_NAME),
    nextRow: Number.isFinite(nextRow) ? Math.floor(nextRow) : CONFIG.DATA_START_ROW,
    runId: String(source.runId || ""),
    updatedAt: String(source.updatedAt || new Date().toISOString()),
    cycleState: String(source.cycleState || "idle"),
  };
}

function sanitizeSyncCursor_(value) {
  const cursor = normalizeSyncCursor_(value);
  return {
    sheet: cursor.sheet,
    nextRow: cursor.nextRow,
    runId: cursor.runId,
    updatedAt: cursor.updatedAt,
    cycleState: cursor.cycleState,
  };
}

function createSyncRunId_() {
  return "students-sync-" + new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14) + "-" +
    Utilities.getUuid().replace(/-/g, "").slice(0, 10);
}

function createRunningSyncCursor_() {
  return {
    sheet: CONFIG.STUDENTS_SHEET_NAME,
    nextRow: CONFIG.DATA_START_ROW,
    runId: createSyncRunId_(),
    updatedAt: new Date().toISOString(),
    cycleState: "running",
  };
}

function runningSyncCursor_(before, sheetName, nextRow) {
  return {
    sheet: String(sheetName || before.sheet || CONFIG.STUDENTS_SHEET_NAME),
    nextRow: Math.max(CONFIG.DATA_START_ROW, Math.floor(Number(nextRow))),
    runId: String(before.runId || createSyncRunId_()),
    updatedAt: new Date().toISOString(),
    cycleState: "running",
  };
}

function completedSyncCursor_(before, sheetName) {
  return {
    sheet: String(sheetName || before.sheet || CONFIG.STUDENTS_SHEET_NAME),
    nextRow: CONFIG.DATA_START_ROW,
    runId: String(before.runId || createSyncRunId_()),
    updatedAt: new Date().toISOString(),
    cycleState: "completed",
  };
}

function loadSyncCursor_() {
  return getFirestoreDocument_("app_config", "sync_students_cursor");
}

function saveSyncCursor_(cursor) {
  replaceFirestoreDocument_("app_config", "sync_students_cursor", sanitizeSyncCursor_(cursor));
}

function loadSyncControl_() {
  return getFirestoreDocument_("app_config", "sync_students_control");
}

function clearSyncControl_() {
  deleteFirestoreDocument_("app_config", "sync_students_control");
}

function effectiveSyncBatchSize_(control, runId) {
  const matchesRun = !control || !control.runId || String(control.runId) === String(runId || "");
  const requested = matchesRun && control ? Number(control.maxRows || 0) : 0;
  if (Number.isFinite(requested) && requested >= 1) {
    return Math.min(CONFIG.SYNC_BATCH_MAX_ROWS, Math.floor(requested));
  }
  return CONFIG.SYNC_BATCH_MAX_ROWS;
}

function createBatchSyncReport_(runId, cursorBefore, startedAtMs) {
  return {
    status: "partial",
    runId: String(runId || ""),
    processed: 0,
    created: 0,
    updated: 0,
    noOp: 0,
    errors: 0,
    cursorBefore: sanitizeSyncCursor_(cursorBefore),
    cursorAfter: sanitizeSyncCursor_(cursorBefore),
    durationMs: Math.max(0, Date.now() - Number(startedAtMs || Date.now())),
    errorCode: null,
    students: { created: 0, updated: 0, noOp: 0, errors: 0 },
    users: { created: 0, updated: 0, noOp: 0, errors: 0 },
    stages: {
      cursorReadMs: 0,
      controlReadMs: 0,
      sheetReadMs: 0,
      firestoreReadMs: 0,
      buildMs: 0,
      writeMs: 0,
      cursorWriteMs: 0,
    },
    metrics: {
      sheetReads: 0,
      firestoreCalls: { reads: 0, writes: 0 },
    },
  };
}

function assertSyncReportHasNoPii_(report) {
  const serialized = JSON.stringify(report || {});
  if (/@/.test(serialized) || /\b(?:CC|TI|RC|CE|PAS|PPT)\s*\d{4,}\b/i.test(serialized)) {
    throw new Error("SYNC_REPORT_PII_DETECTED");
  }
  const forbiddenKeys = ["email", "correo", "document", "payload", "message", "studentId", "name"];
  const stack = [report || {}];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    Object.keys(current).forEach(function (key) {
      const normalized = String(key).toLowerCase();
      if (forbiddenKeys.some(function (forbidden) { return normalized.indexOf(forbidden.toLowerCase()) !== -1; })) {
        throw new Error("SYNC_REPORT_PII_KEY_DETECTED");
      }
      stack.push(current[key]);
    });
  }
}

function saveSyncBatchReport_(report) {
  assertSyncReportHasNoPii_(report);
  replaceFirestoreDocument_("app_config", "sync_students_last_report", report);
}

function isSyncBudgetReached_(startedAtMs, nowMs, budgetMs, safetyMarginMs) {
  return Number(nowMs) - Number(startedAtMs) >= Number(budgetMs) - Number(safetyMarginMs || 0);
}

function safeSyncErrorCode_(error) {
  const text = String(error && error.message ? error.message : error || "").toUpperCase();
  if (text.indexOf("LOCK_BUSY") !== -1) return "LOCK_BUSY";
  if (text.indexOf("PERMISSION") !== -1 || text.indexOf("403") !== -1) return "FIRESTORE_PERMISSION_DENIED";
  if (text.indexOf("RESOURCE_EXHAUSTED") !== -1 || text.indexOf("429") !== -1) return "FIRESTORE_RESOURCE_EXHAUSTED";
  if (text.indexOf("DEADLINE") !== -1 || text.indexOf("TIME") !== -1) return "UPSTREAM_DEADLINE";
  if (text.indexOf("SYNC_REPORT_PII") !== -1) return "SYNC_REPORT_PII_REJECTED";
  return "SYNC_FAILED";
}

function getStudentSheetForSync_() {
  return getSheetByCandidates_(CONFIG.STUDENTS_SHEET_NAME, CONFIG.STUDENTS_SHEET_CANDIDATES);
}

function readStudentRowsBatch_(sheet, startRow, maxRows) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  const safeStart = Math.max(CONFIG.DATA_START_ROW, Math.floor(Number(startRow || CONFIG.DATA_START_ROW)));
  if (lastRow < safeStart || lastCol < 1) {
    return { sheetName: sheet.getName(), lastRow: lastRow, rows: [] };
  }
  const count = Math.min(Math.max(1, Math.floor(Number(maxRows || 1))), lastRow - safeStart + 1);
  const values = sheet.getRange(safeStart, 1, count, lastCol).getValues();
  return {
    sheetName: sheet.getName(),
    lastRow: lastRow,
    rows: values.map(function (row, index) {
      return { rowNumber: safeStart + index, values: row };
    }),
  };
}

function parseBatchGetResponse_(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    return raw.split(/\r?\n/).filter(Boolean).map(function (line) { return JSON.parse(line); });
  }
}

function batchGetFirestoreDocuments_(collectionName, docIds) {
  const uniqueIds = Array.from(new Set((docIds || []).map(function (id) {
    return String(id || "").trim();
  }).filter(Boolean)));
  if (!uniqueIds.length) return {};
  const names = uniqueIds.map(function (docId) {
    return firestoreDocumentName_(collectionName, docId);
  });
  const response = UrlFetchApp.fetch(firestoreBaseUrl_() + "/documents:batchGet", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + getFirestoreAccessToken_() },
    payload: JSON.stringify({ documents: names }),
    muteHttpExceptions: true,
  });
  assertFirestoreResponse_(response, "batchGet " + collectionName);
  const result = {};
  parseBatchGetResponse_(response.getContentText()).forEach(function (item) {
    if (!item || !item.found) return;
    const parts = String(item.found.name || "").split("/");
    const docId = decodeURIComponent(parts[parts.length - 1]);
    result[docId] = decodeFirestoreFields_(item.found.fields || {});
  });
  return result;
}

function normalizedSyncIds_(values) {
  const seen = {};
  (values || []).forEach(function (value) {
    const text = String(value || "").trim();
    if (text) seen[text] = true;
  });
  return Object.keys(seen).sort();
}

function managedSyncValuesEqual_(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return JSON.stringify(normalizedSyncIds_(Array.isArray(left) ? left : [])) ===
      JSON.stringify(normalizedSyncIds_(Array.isArray(right) ? right : []));
  }
  if (left && typeof left === "object" || right && typeof right === "object") {
    return JSON.stringify(left || null) === JSON.stringify(right || null);
  }
  const leftValue = left === undefined || left === null ? "" : left;
  const rightValue = right === undefined || right === null ? "" : right;
  return String(leftValue) === String(rightValue);
}

function hasManagedSyncChanges_(existing, payload) {
  if (!existing) return true;
  return Object.keys(payload || {}).some(function (key) {
    if (key === "createdAt" || key === "updatedAt") return false;
    return !managedSyncValuesEqual_(existing[key], payload[key]);
  });
}

function buildManagedStudentSyncPayload_(student, existing) {
  const normalized = normalizeStudentForFirestore_(student);
  normalized.processes = mergeProcessesWithExisting_(existing ? existing.processes : [], normalized.processes);
  normalized.source = "students_sheet_sync";
  normalized.syncOrigin = "apps_script_trigger";
  return normalized;
}

function studentAliasesForUserSync_(student) {
  return normalizedSyncIds_([
    student && student.studentKey,
    student && student.id,
    student && student.studentId,
    student && student.estudianteId,
    student && student.documento,
    student && student.identificacion,
    student && student.numeroDocumento,
    student && student.sourceRow,
  ].concat(Array.isArray(student && student.studentIds) ? student.studentIds : []));
}

function buildManagedUserSyncPayload_(existing, email, group) {
  const members = Array.isArray(group) ? group : [];
  const primary = members[0] || {};
  const ids = normalizedSyncIds_((existing && existing.studentIds || [])
    .concat(existing && existing.studentId || [])
    .concat(members.reduce(function (all, member) {
      return all.concat(studentAliasesForUserSync_(member));
    }, [])));
  const sheetStudentKey = String(primary.studentKey || primary.id || primary.studentId || "").trim();
  const studentKey = String(existing && existing.studentKey || sheetStudentKey).trim();
  const payload = {
    email: String(existing && existing.email || email).trim().toLowerCase(),
    studentId: selectCanonicalUserStudentId_(existing || null, ids, sheetStudentKey),
    studentKey: studentKey,
    studentIds: ids,
    displayName: String(existing && existing.displayName || primary.nombre || primary.name || "").trim(),
    source: String(existing && existing.source || "students_sheet_sync"),
    sourceRow: existing && existing.sourceRow !== undefined && existing.sourceRow !== null
      ? existing.sourceRow
      : primary.sourceRow || null,
    syncOrigin: String(existing && existing.syncOrigin || "apps_script_trigger"),
  };
  if (!existing) {
    payload.emailNormalized = String(email || "").trim().toLowerCase();
    payload.role = "student";
    payload.studentStatus = String(primary.estado || primary.status || primary.estadoActual || "").trim();
    payload.active = isStudentAllowedToLogInForSync_(primary);
  }
  return payload;
}

function buildManagedSyncOperation_(collectionName, docId, existing, payload, nowIso) {
  if (!hasManagedSyncChanges_(existing, payload)) return null;
  const writePayload = Object.assign({}, payload, { updatedAt: nowIso });
  if (!existing) writePayload.createdAt = nowIso;
  return { collectionName: collectionName, docId: docId, payload: writePayload };
}

function processStudentRowsBatch_(rowRecords, startedAtMs) {
  const mapped = (rowRecords || []).map(mapRowToStudent_).filter(Boolean);
  const studentIds = [];
  const groupsByEmail = {};
  const emailOrder = [];
  let invalidRows = (rowRecords || []).length - mapped.length;

  mapped.forEach(function (student) {
    const studentKey = String(student.studentKey || student.id || student.studentId || "").trim();
    if (studentKey) studentIds.push(studentKey);
    else invalidRows += 1;
    const emails = (Array.isArray(student.emails) && student.emails.length
      ? student.emails
      : [student.email || student.correo || student.correoElectronico]
    ).map(normalizeEmail_).filter(Boolean);
    emails.forEach(function (email) {
      if (!groupsByEmail[email]) {
        groupsByEmail[email] = [];
        emailOrder.push(email);
      }
      groupsByEmail[email].push(student);
    });
  });

  const firestoreReadStartedAt = Date.now();
  const existingStudents = batchGetFirestoreDocuments_("students", studentIds);
  const existingUsers = batchGetFirestoreDocuments_("users", emailOrder);
  const firestoreReadMs = Date.now() - firestoreReadStartedAt;

  const buildStartedAt = Date.now();
  const operations = [];
  const students = { created: 0, updated: 0, noOp: 0, errors: invalidRows };
  const users = { created: 0, updated: 0, noOp: 0, errors: 0 };
  const nowIso = new Date().toISOString();

  mapped.forEach(function (student) {
    const studentKey = String(student.studentKey || student.id || student.studentId || "").trim();
    if (!studentKey) return;
    const existing = existingStudents[studentKey] || null;
    const payload = buildManagedStudentSyncPayload_(student, existing);
    const operation = buildManagedSyncOperation_("students", studentKey, existing, payload, nowIso);
    if (!operation) students.noOp += 1;
    else {
      operations.push(operation);
      if (existing) students.updated += 1;
      else students.created += 1;
    }
  });

  emailOrder.forEach(function (email) {
    const existing = existingUsers[email] || null;
    const role = normalizeText_(existing && (existing.role || existing.rol));
    if (existing && role && role !== "student" && role !== "estudiante") {
      users.errors += 1;
      return;
    }
    const payload = buildManagedUserSyncPayload_(existing, email, groupsByEmail[email]);
    const operation = buildManagedSyncOperation_("users", email, existing, payload, nowIso);
    if (!operation) users.noOp += 1;
    else {
      operations.push(operation);
      if (existing) users.updated += 1;
      else users.created += 1;
    }
  });
  const buildMs = Date.now() - buildStartedAt;

  if (isSyncBudgetReached_(startedAtMs, Date.now(), CONFIG.SYNC_BUDGET_MS, CONFIG.SYNC_SAFETY_MARGIN_MS)) {
    return {
      processed: 0,
      created: 0,
      updated: 0,
      noOp: 0,
      errors: invalidRows,
      students: { created: 0, updated: 0, noOp: 0, errors: invalidRows },
      users: { created: 0, updated: 0, noOp: 0, errors: 0 },
      firestoreReadMs: firestoreReadMs,
      buildMs: buildMs,
      writeMs: 0,
      firestoreReadCalls: 2,
      firestoreWriteCalls: 0,
      budgetReached: true,
    };
  }

  const writeStartedAt = Date.now();
  if (operations.length) commitFirestoreOperations_(operations);
  const writeMs = Date.now() - writeStartedAt;
  return {
    processed: (rowRecords || []).length,
    created: students.created + users.created,
    updated: students.updated + users.updated,
    noOp: students.noOp + users.noOp,
    errors: students.errors + users.errors,
    students: students,
    users: users,
    firestoreReadMs: firestoreReadMs,
    buildMs: buildMs,
    writeMs: writeMs,
    firestoreReadCalls: 2,
    firestoreWriteCalls: operations.length ? 1 : 0,
    budgetReached: false,
  };
}

function syncStudentsSheetToFirestore(options) {
  options = options || {};
  const report = options.report || createSyncReport_(new Date());
  const students = getStudentRows_().map(mapRowToStudent_).filter(Boolean);
  const existingDocs = listFirestoreCollection_("students");
  const existingById = {};
  const operations = [];
  const ownReport = {
    totalStudentsRead: students.length,
    validStudents: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skippedInvalid: 0,
    deactivatedMissingFromSheet: 0,
    students: students,
  };
  const seenStudentKeys = {};

  existingDocs.forEach(function (doc) {
    if (doc && doc.id) existingById[doc.id] = doc.data || {};
  });

  report.totalStudentsRead = students.length;

  students.forEach(function (student) {
    const normalized = normalizeStudentForFirestore_(student);

    if (!normalized.studentKey) {
      report.skippedInvalid += 1;
      ownReport.skippedInvalid += 1;
      return;
    }

    report.validStudents += 1;
    ownReport.validStudents += 1;
    seenStudentKeys[normalized.studentKey] = true;

    const existing = existingById[normalized.studentKey] || null;
    // Conserva las areas agregadas a mano desde Bitácoras: la hoja no las
    // conoce y sin este merge cada sync las borraria del doc de Firestore.
    normalized.processes = mergeProcessesWithExisting_(
      existing ? existing.processes : [],
      normalized.processes
    );
    if (!hasStudentFirestoreChanges_(existing, normalized)) {
      report.unchanged += 1;
      ownReport.unchanged += 1;
      return;
    }

    const now = new Date().toISOString();
    const payload = Object.assign({}, normalized, {
      source: "students_sheet_sync",
      syncOrigin: "apps_script_trigger",
      updatedAt: now,
    });

    if (!existing) payload.createdAt = now;

    operations.push({
      collectionName: "students",
      docId: normalized.studentKey,
      payload: payload,
    });

    if (existing) {
      report.updated += 1;
      ownReport.updated += 1;
    } else {
      report.created += 1;
      ownReport.created += 1;
    }
  });

  /*
    Limpieza: docs de students que vinieron de la hoja pero cuya fila ya no
    existe (o cambio de clave) se marcan obsoletos. No se borran porque las
    bitacoras viejas los referencian. Solo se tocan docs creados por el sync,
    nunca docs creados a mano desde otras apps.
  */
  Object.keys(existingById).forEach(function (docId) {
    if (seenStudentKeys[docId]) return;

    const data = existingById[docId];
    if (data.source !== "students_sheet_sync") return;
    if (data.obsolete === true) return;

    operations.push({
      collectionName: "students",
      docId: docId,
      payload: {
        obsolete: true,
        active: false,
        obsoleteReason: "Ya no aparece en la hoja Inscripcion estudiantes",
        syncOrigin: "apps_script_trigger",
        updatedAt: new Date().toISOString(),
      },
    });
    ownReport.deactivatedMissingFromSheet += 1;
  });

  commitFirestoreOperations_(operations);
  return ownReport;
}

function syncStudentAccessUsersToFirestore(options) {
  options = options || {};
  const report = options.report || createSyncReport_(new Date());
  const students = Array.isArray(options.students)
    ? options.students
    : getStudentRows_().map(mapRowToStudent_).filter(Boolean);
  const existingUsers = listFirestoreCollection_("users");
  const existingByEmail = {};
  const existingStudentIdsByEmail = {};
  const groupsByEmail = {};
  const emailOrder = [];
  const operations = [];
  const ownReport = {
    totalStudentsRead: students.length,
    validStudents: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skippedMissingEmail: 0,
    skippedDuplicateEmail: 0,
    conflicts: 0,
    deactivatedMissingFromSheet: 0,
  };

  existingUsers.forEach(function (user) {
    const data = user.data || {};
    const email = normalizeEmail_(data.email || (user.id.indexOf("@") !== -1 ? user.id : ""));
    if (!email) return;

    const record = Object.assign({ id: user.id }, data);
    const current = existingByEmail[email];
    // Preferir siempre el doc canonico users/{correo} sobre docs legados.
    if (!current || user.id === email) {
      existingByEmail[email] = record;
    }

    // Acumular studentIds de todos los docs del mismo correo para fusionarlos.
    const ids = existingStudentIdsByEmail[email] || (existingStudentIdsByEmail[email] = {});
    (Array.isArray(data.studentIds) ? data.studentIds : []).forEach(function (sid) {
      const safeSid = String(sid || "").trim();
      if (safeSid) ids[safeSid] = true;
    });
    const singleId = String(data.studentId || data.studentKey || data.estudianteId || "").trim();
    if (singleId) ids[singleId] = true;
  });

  // Un acudiente puede tener varios hijos con el mismo correo (agrupar filas)
  // y una fila puede traer varios correos (acudiente + estudiante): cada
  // correo recibe su propio doc users/{correo} con los mismos estudiantes.
  students.forEach(function (student) {
    const emails = (Array.isArray(student.emails) && student.emails.length
      ? student.emails
      : [student.email || student.correo || student.correoElectronico]
    )
      .map(normalizeEmail_)
      .filter(Boolean);

    if (!emails.length) {
      report.skippedMissingEmail += 1;
      ownReport.skippedMissingEmail += 1;
      return;
    }

    emails.forEach(function (email) {
      if (groupsByEmail[email]) {
        report.skippedDuplicateEmail += 1;
        ownReport.skippedDuplicateEmail += 1;
        groupsByEmail[email].push(student);
        return;
      }

      groupsByEmail[email] = [student];
      emailOrder.push(email);
    });
  });

  emailOrder.forEach(function (email) {
    const group = groupsByEmail[email];

    report.validStudents += 1;
    ownReport.validStudents += 1;

    const existing = existingByEmail[email] || null;
    const canonical = existing && existing.id === email ? existing : null;
    const role = normalizeText_(existing && (existing.role || existing.rol));

    if (existing && role && role !== "student" && role !== "estudiante") {
      report.conflicts += 1;
      ownReport.conflicts += 1;
      return;
    }

    let primary = group[0];
    let anyActive = false;
    group.forEach(function (member) {
      if (isStudentAllowedToLogInForSync_(member)) {
        if (!anyActive) primary = member;
        anyActive = true;
      }
    });

    const idsMap = existingStudentIdsByEmail[email] || {};
    group.forEach(function (member) {
      [
        member.studentKey,
        member.id,
        member.studentId,
        member.estudianteId,
        member.documento,
        member.identificacion,
        member.numeroDocumento,
        member.sourceRow,
      ]
        .concat(Array.isArray(member.studentIds) ? member.studentIds : [])
        .forEach(function (memberId) {
          const safeMemberId = String(memberId || "").trim();
          if (safeMemberId) idsMap[safeMemberId] = true;
        });

      (Array.isArray(member.duplicateRecords) ? member.duplicateRecords : []).forEach(function (record) {
        [
          record && record.studentKey,
          record && record.id,
          record && record.studentId,
          record && record.estudianteId,
          record && record.documento,
        ].forEach(function (duplicateId) {
          const safeDuplicateId = String(duplicateId || "").trim();
          if (safeDuplicateId) idsMap[safeDuplicateId] = true;
        });
      });
    });
    const studentIds = Object.keys(idsMap).sort();
    const studentKey = String(primary.studentKey || primary.id || primary.studentId || "").trim();
    const studentId = selectCanonicalUserStudentId_(canonical, studentIds, studentKey);

    const now = new Date().toISOString();
    const payload = {
      email: email,
      role: "student",
      studentId: studentId,
      studentKey: studentKey,
      studentIds: studentIds,
      displayName: String(primary.nombre || primary.name || primary.nombreCompleto || "").trim(),
      studentStatus: String(primary.estado || primary.status || primary.estadoActual || "").trim(),
      active: anyActive,
      source: "students_sheet_sync",
      sourceRow: primary.sourceRow || null,
      syncOrigin: "apps_script_trigger",
      updatedAt: now,
    };

    if (canonical && !hasUserAccessChanges_(canonical, payload)) {
      report.unchanged += 1;
      ownReport.unchanged += 1;
      return;
    }

    if (!canonical) payload.createdAt = now;

    operations.push({
      collectionName: "users",
      docId: email,
      payload: payload,
    });

    if (canonical) {
      report.updated += 1;
      ownReport.updated += 1;
    } else {
      report.created += 1;
      ownReport.created += 1;
    }
  });

  /*
    Limpieza de accesos: un doc users/{correo} creado por el sync cuyo correo
    ya no aparece en NINGUNA fila de la hoja pierde el acceso (active: false).
    No se tocan docentes/admins ni docs creados a mano (source distinto).
  */
  Object.keys(existingByEmail).forEach(function (email) {
    if (groupsByEmail[email]) return;

    const existing = existingByEmail[email];
    if (existing.id !== email) return; // solo docs canonicos
    if (existing.source !== "students_sheet_sync" && existing.source !== "users_legacy_migration") return;

    const role = normalizeText_(existing.role || existing.rol);
    if (role && role !== "student" && role !== "estudiante") return;
    if (existing.active === false) return;

    operations.push({
      collectionName: "users",
      docId: email,
      payload: {
        active: false,
        staleReason: "El correo ya no aparece en la hoja Inscripcion estudiantes",
        syncOrigin: "apps_script_trigger",
        updatedAt: new Date().toISOString(),
      },
    });
    ownReport.deactivatedMissingFromSheet += 1;
  });

  commitFirestoreOperations_(operations);
  return ownReport;
}

/**
 * Migracion unica: fusiona los docs de `users` con ID distinto al correo
 * (legados tipo student_stu_<nombre>_<fila> o telefonos) dentro del doc
 * canonico users/{correo} y elimina los legados. Los docs sin correo se
 * marcan como obsoletos. Es idempotente: una segunda corrida no encuentra
 * docs legados y no cambia nada. Ejecutar manualmente desde el editor.
 */
function migrateLegacyUserAccessDocs() {
  const users = listFirestoreCollection_("users");
  const canonicalByEmail = {};
  const legacyByEmail = {};
  const orphanDocs = [];
  const writes = [];
  const report = {
    totalDocs: users.length,
    emailsWithLegacy: 0,
    canonicalCreated: 0,
    canonicalUpdated: 0,
    legacyDeleted: 0,
    orphansMarkedObsolete: 0,
    skippedNonStudentRole: 0,
    startedAt: new Date().toISOString(),
  };

  users.forEach(function (user) {
    const data = user.data || {};
    const email = normalizeEmail_(data.email || (user.id.indexOf("@") !== -1 ? user.id : ""));

    if (!email) {
      orphanDocs.push(user);
      return;
    }

    if (user.id === email) {
      canonicalByEmail[email] = data;
      return;
    }

    if (!legacyByEmail[email]) legacyByEmail[email] = [];
    legacyByEmail[email].push(user);
  });

  Object.keys(legacyByEmail).forEach(function (email) {
    const legacyDocs = legacyByEmail[email];
    const canonical = canonicalByEmail[email] || null;
    const canonicalRole = normalizeText_(canonical && (canonical.role || canonical.rol));
    const isNonStudentRole =
      canonicalRole && canonicalRole !== "student" && canonicalRole !== "estudiante";

    report.emailsWithLegacy += 1;

    const idsMap = {};
    const collectIds = function (data) {
      (Array.isArray(data.studentIds) ? data.studentIds : []).forEach(function (sid) {
        const safeSid = String(sid || "").trim();
        if (safeSid) idsMap[safeSid] = true;
      });
      const singleId = String(data.studentId || data.studentKey || data.estudianteId || "").trim();
      if (singleId) idsMap[singleId] = true;
    };

    if (canonical) collectIds(canonical);
    legacyDocs.forEach(function (legacy) {
      collectIds(legacy.data || {});
    });

    const studentIds = Object.keys(idsMap).sort();
    const anyLegacyActive = legacyDocs.some(function (legacy) {
      return (legacy.data || {}).active === true;
    });
    // Base para nombre/estado: el legado activo mas reciente, o el canonico.
    const activeLegacy = legacyDocs.filter(function (legacy) {
      return (legacy.data || {}).active === true;
    });
    const base = (canonical && canonical.displayName ? canonical : null) ||
      (activeLegacy.length ? activeLegacy[0].data : legacyDocs[0].data) || {};

    if (isNonStudentRole) {
      // No degradar docentes/admin: solo fusionar studentIds si aporta algo.
      report.skippedNonStudentRole += 1;
    } else {
      const now = new Date().toISOString();
      const payload = {
        email: email,
        role: "student",
        studentId: String(base.studentId || base.studentKey || studentIds[0] || "").trim() || (studentIds[0] || ""),
        studentKey: String(base.studentKey || base.studentId || studentIds[0] || "").trim() || (studentIds[0] || ""),
        studentIds: studentIds,
        displayName: String(base.displayName || base.nombre || base.name || "").trim(),
        studentStatus: String(base.studentStatus || base.estado || base.status || "").trim(),
        active: (canonical && canonical.active === true) || anyLegacyActive,
        source: "users_legacy_migration",
        syncOrigin: "apps_script_migration",
        updatedAt: now,
      };

      if (!canonical) payload.createdAt = now;

      writes.push(buildSetWrite_("users", email, payload));

      if (canonical) {
        report.canonicalUpdated += 1;
      } else {
        report.canonicalCreated += 1;
        canonicalByEmail[email] = payload;
      }
    }

    legacyDocs.forEach(function (legacy) {
      writes.push(buildDeleteWrite_("users", legacy.id));
      report.legacyDeleted += 1;
    });
  });

  orphanDocs.forEach(function (orphan) {
    const data = orphan.data || {};
    if (data.obsolete === true) return;

    writes.push(
      buildSetWrite_("users", orphan.id, {
        obsolete: true,
        obsoleteReason: "ID sin correo; reemplazado por users/{correo}",
        active: false,
        syncOrigin: "apps_script_migration",
        updatedAt: new Date().toISOString(),
      })
    );
    report.orphansMarkedObsolete += 1;
  });

  commitFirestoreWrites_(writes);

  report.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
  return report;
}

function setupAutoSyncTrigger() {
  deleteAutoSyncTriggers();

  return ScriptApp.newTrigger("syncAllSheetsToFirestore")
    .timeBased()
    .everyHours(1)
    .create();
}

function deleteAutoSyncTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "syncAllSheetsToFirestore") {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function diagnoseFirestoreRestAuth() {
  const projectId = getRequiredScriptProperty_("FIREBASE_PROJECT_ID");
  const clientEmail = getRequiredScriptProperty_("FIREBASE_CLIENT_EMAIL");
  getRequiredScriptProperty_("FIREBASE_PRIVATE_KEY");

  const report = {
    FIREBASE_PROJECT_ID: projectId,
    FIREBASE_CLIENT_EMAIL: clientEmail,
    hasPrivateKey: true,
    accessTokenGenerated: false,
    studentsReadUrl:
      firestoreBaseUrl_() + "/documents/students?pageSize=1",
    studentsReadStatus: null,
    firestoreResponse: null,
  };

  try {
    const accessToken = getFirestoreAccessToken_({ forceRefresh: true });
    report.accessTokenGenerated = Boolean(accessToken);

    const response = UrlFetchApp.fetch(report.studentsReadUrl, {
      method: "get",
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json",
      },
      muteHttpExceptions: true,
    });

    report.studentsReadStatus = response.getResponseCode();
    report.firestoreResponse = safeParseJson_(response.getContentText());
  } catch (error) {
    report.error = error && error.message ? error.message : String(error);
  }

  console.log(JSON.stringify(report, null, 2));
  return report;
}

function createSyncReport_(startedAt) {
  return {
    totalStudentsRead: 0,
    validStudents: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skippedInvalid: 0,
    skippedMissingEmail: 0,
    skippedDuplicateEmail: 0,
    conflicts: 0,
    synced: 0,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    source: "apps_script_trigger",
  };
}

function stripInternalSyncReport_(report) {
  const copy = Object.assign({}, report || {});
  delete copy.students;
  return copy;
}

function processIdentity_(process) {
  if (!process || typeof process !== "object") return "";
  const area = String(process.arte || process.area || "").trim().toLowerCase();
  const detail = String(process.detalle || process.instrumento || "").trim().toLowerCase();
  if (!area && !detail) return "";
  return area + "|" + detail;
}

function mergeProcessesWithExisting_(existingProcesses, syncedProcesses) {
  const synced = Array.isArray(syncedProcesses) ? syncedProcesses : [];
  const existing = Array.isArray(existingProcesses) ? existingProcesses : [];
  const syncedIdentities = {};
  synced.forEach(function (process) {
    const identity = processIdentity_(process);
    if (identity) syncedIdentities[identity] = true;
  });
  const kept = existing.filter(function (process) {
    const identity = processIdentity_(process);
    return identity && !syncedIdentities[identity];
  });
  return synced.concat(kept);
}

function normalizeStudentForFirestore_(student) {
  const studentKey = String(student.studentKey || student.id || student.studentId || "").trim();
  return {
    studentKey: studentKey,
    id: studentKey,
    nombre: String(student.nombre || student.name || "").trim(),
    name: String(student.name || student.nombre || "").trim(),
    estado: String(student.estado || student.status || "").trim(),
    edad: student.edad === undefined ? null : student.edad,
    email: normalizeEmail_(student.email || student.correo || student.correoElectronico),
    correo: normalizeEmail_(student.correo || student.email || student.correoElectronico),
    correoElectronico: normalizeEmail_(student.correoElectronico || student.email || student.correo),
    interesesMusicales: String(student.interesesMusicales || student.intereses || "").trim(),
    intereses: String(student.intereses || student.interesesMusicales || "").trim(),
    processes: Array.isArray(student.processes) ? student.processes : [],
    sourceRow: student.sourceRow || null,
  };
}

function hasStudentFirestoreChanges_(existing, next) {
  if (!existing) return true;

  const keys = [
    "nombre",
    "email",
    "correo",
    "correoElectronico",
    "edad",
    "estado",
    "interesesMusicales",
    "curso",
    "area",
    "programa",
    "instrumento",
    "modalidad",
    "sede",
    "docente",
    "acudiente",
    "sourceRow",
  ];

  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const currentValue = existing[key] === undefined || existing[key] === null ? "" : existing[key];
    const nextValue = next[key] === undefined || next[key] === null ? "" : next[key];
    if (String(currentValue) !== String(nextValue)) return true;
  }

  return JSON.stringify(existing.processes || []) !== JSON.stringify(next.processes || []);
}

function hasUserAccessChanges_(existing, next) {
  if (!existing) return true;

  const keys = [
    "email",
    "role",
    "studentId",
    "studentKey",
    "displayName",
    "studentStatus",
    "active",
    "source",
    "sourceRow",
    "syncOrigin",
  ];

  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const currentValue = existing[key] === undefined || existing[key] === null ? "" : existing[key];
    const nextValue = next[key] === undefined || next[key] === null ? "" : next[key];
    if (String(currentValue) !== String(nextValue)) return true;
  }

  const currentIds = (Array.isArray(existing.studentIds) ? existing.studentIds : [])
    .map(function (sid) { return String(sid || "").trim(); })
    .filter(Boolean)
    .sort();
  const nextIds = (Array.isArray(next.studentIds) ? next.studentIds : [])
    .map(function (sid) { return String(sid || "").trim(); })
    .filter(Boolean)
    .sort();

  return JSON.stringify(currentIds) !== JSON.stringify(nextIds);
}

/*
 * El sync de la hoja conserva el studentId escalar ya canonizado por el
 * backfill cuando sigue vinculado en studentIds. La hoja continúa aportando
 * studentKey como alias legado, pero no puede degradar el ID canónico.
 */
function selectCanonicalUserStudentId_(existing, studentIds, sheetStudentKey) {
  const currentStudentId = String(existing && existing.studentId || "").trim();
  const linkedIds = Array.isArray(studentIds) ? studentIds : [];
  if (currentStudentId && linkedIds.indexOf(currentStudentId) !== -1) {
    return currentStudentId;
  }
  return String(sheetStudentKey || "").trim();
}

function isStudentAllowedToLogInForSync_(student) {
  const status = normalizeText_(student && (student.estado || student.status || student.estadoActual));
  return (
    status === "activo" ||
    status.indexOf("activo no registro") === 0 ||
    status.indexOf("activo en pausa") === 0 ||
    status.indexOf("inactivo en pausa") === 0
  );
}

function normalizeEmail_(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

/**
 * Extrae TODOS los correos presentes en un texto (la celda puede traer
 * "mama@x.com, hijo@y.com" o correos con espacios colados). Devuelve la
 * lista en minusculas, sin duplicados y en orden de aparicion.
 */
function extractEmails_(value) {
  const matches = String(value || "")
    .toLowerCase()
    .match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g);

  if (!matches) return [];

  const seen = {};
  return matches.filter(function (email) {
    if (seen[email]) return false;
    seen[email] = true;
    return true;
  });
}

function saveSyncReportToFirestore_(report) {
  setFirestoreDocument_("app_config", "sync_students_last_report", report);
}

function sendSyncFailureAlert_(report) {
  if (!CONFIG.ALERT_EMAIL) return;

  MailApp.sendEmail(
    CONFIG.ALERT_EMAIL,
    "[Bitacoras] Fallo la sincronizacion de estudiantes",
    "La sincronizacion automatica Sheets -> Firestore fallo.\n\n" +
      "Error: " + (report.error || "desconocido") + "\n\n" +
      "Reporte completo:\n" + JSON.stringify(report, null, 2)
  );
}

/**
 * Herramienta de diagnostico: dado un correo, responde por que un estudiante
 * puede (o no) entrar a Estudiantes HUB. Ejecutar desde el editor:
 *   diagnoseStudentAccess("correo@ejemplo.com")
 * Revisa el doc users/{correo}, su rol/estado/studentIds y que cada
 * students/{id} exista. El resultado queda en el log.
 */
function diagnoseStudentAccess(email) {
  const normalized = normalizeEmail_(email);
  const report = {
    email: normalized,
    userDocExists: false,
    userDoc: null,
    role: null,
    active: null,
    studentIds: [],
    studentsFound: {},
    verdict: "",
  };

  if (!normalized) {
    report.verdict = "Correo vacio o invalido.";
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  const userDoc = getFirestoreDocument_("users", normalized);
  if (!userDoc) {
    report.verdict =
      "NO existe users/" + normalized + ". El HUB lo va a rechazar. " +
      "Verifica que ese correo este en la hoja y corre syncAllSheetsToFirestore.";
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  report.userDocExists = true;
  report.userDoc = userDoc;
  report.role = userDoc.role || userDoc.rol || null;
  report.active = userDoc.active;
  report.studentIds = Array.isArray(userDoc.studentIds) ? userDoc.studentIds : [];

  report.studentIds.forEach(function (sid) {
    report.studentsFound[sid] = Boolean(getFirestoreDocument_("students", sid));
  });

  const problems = [];
  const role = normalizeText_(report.role);
  if (role !== "student" && role !== "estudiante" && role !== "acudiente" &&
      role !== "guardian" && role !== "parent") {
    problems.push('role es "' + report.role + '" (las reglas esperan student/estudiante/acudiente).');
  }
  if (userDoc.active === false) {
    problems.push("active es false (estudiante inactivo segun la hoja).");
  }
  if (!report.studentIds.length) {
    problems.push("studentIds esta vacio: las reglas exigen al menos un estudiante enlazado.");
  }
  Object.keys(report.studentsFound).forEach(function (sid) {
    if (!report.studentsFound[sid]) {
      problems.push("students/" + sid + " no existe en Firestore.");
    }
  });

  report.verdict = problems.length
    ? "BLOQUEADO: " + problems.join(" | ")
    : "OK: este correo deberia poder entrar al HUB y ver sus estudiantes.";

  console.log(JSON.stringify(report, null, 2));
  return report;
}

function getFirestoreDocument_(collectionName, docId) {
  const url =
    firestoreBaseUrl_() +
    "/documents/" +
    encodeURIComponent(collectionName) +
    "/" +
    encodeURIComponent(docId);

  const response = UrlFetchApp.fetch(url, {
    method: "get",
    headers: {
      Authorization: "Bearer " + getFirestoreAccessToken_(),
      "Content-Type": "application/json",
    },
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() === 404) return null;
  assertFirestoreResponse_(response, "leer " + collectionName + "/" + docId);

  const payload = JSON.parse(response.getContentText() || "{}");
  return decodeFirestoreFields_(payload.fields || {});
}

function commitFirestoreOperations_(operations) {
  const writes = (operations || []).map(function (operation) {
    return buildSetWrite_(operation.collectionName, operation.docId, operation.payload);
  });
  commitFirestoreWrites_(writes);
}

function firestoreDocumentName_(collectionName, docId) {
  return (
    "projects/" +
    getFirebaseProjectId_() +
    "/databases/(default)/documents/" +
    collectionName +
    "/" +
    docId
  );
}

function buildSetWrite_(collectionName, docId, payload) {
  return {
    update: {
      name: firestoreDocumentName_(collectionName, docId),
      fields: encodeFirestoreFields_(payload || {}),
    },
    // Mismo comportamiento merge que el PATCH individual con updateMask.
    updateMask: { fieldPaths: Object.keys(payload || {}) },
  };
}

function buildDeleteWrite_(collectionName, docId) {
  return { delete: firestoreDocumentName_(collectionName, docId) };
}

/**
 * Envia escrituras a Firestore via :batchWrite en lotes de hasta 500.
 * Antes cada doc era un PATCH/DELETE HTTP individual y las corridas grandes
 * (sync inicial, migraciones) se morian por "Exceeded maximum execution time".
 *
 * Firestore limita el ancho de banda de escrituras: en corridas grandes devuelve
 * RESOURCE_EXHAUSTED ("exceeded their maximum bandwidth for writes"). Por eso:
 *  - se pausa brevemente entre lotes para "ramp up" gradual,
 *  - cada lote se reintenta con espera exponencial cuando el error es transitorio,
 *  - dentro del lote solo se reintentan las escrituras que fallaron por throttling.
 */
function commitFirestoreWrites_(writes) {
  const BATCH_SIZE = 500;
  const PAUSE_BETWEEN_BATCHES_MS = 250;
  const all = writes || [];

  for (let i = 0; i < all.length; i += BATCH_SIZE) {
    const chunk = all.slice(i, i + BATCH_SIZE);
    commitFirestoreBatchWithRetry_(chunk, i);

    if (i + BATCH_SIZE < all.length && PAUSE_BETWEEN_BATCHES_MS > 0) {
      Utilities.sleep(PAUSE_BETWEEN_BATCHES_MS);
    }
  }
}

/**
 * Codigos gRPC transitorios que conviene reintentar (google.rpc.Code).
 * 8 RESOURCE_EXHAUSTED, 14 UNAVAILABLE, 10 ABORTED, 4 DEADLINE_EXCEEDED, 13 INTERNAL.
 */
function isRetryableFirestoreCode_(code) {
  return code === 8 || code === 14 || code === 10 || code === 4 || code === 13;
}

function commitFirestoreBatchWithRetry_(chunk, baseIndex) {
  const MAX_ATTEMPTS = 6;
  const BASE_DELAY_MS = 1000;

  // pending[k] = indice (relativo al chunk) de una escritura aun no confirmada.
  let pending = [];
  for (let k = 0; k < chunk.length; k += 1) pending.push(k);

  let lastError = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      // Espera exponencial con jitter antes de reintentar.
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 250);
      Utilities.sleep(delay);
    }

    const subChunk = pending.map(function (k) {
      return chunk[k];
    });

    const response = UrlFetchApp.fetch(firestoreBaseUrl_() + "/documents:batchWrite", {
      method: "post",
      contentType: "application/json",
      headers: {
        Authorization: "Bearer " + getFirestoreAccessToken_(),
      },
      payload: JSON.stringify({ writes: subChunk }),
      muteHttpExceptions: true,
    });

    const httpCode = response.getResponseCode();

    // Throttling / indisponibilidad a nivel HTTP: reintentar todo el sub-lote.
    if (httpCode === 429 || httpCode === 500 || httpCode === 503) {
      lastError = new Error(
        "batchWrite HTTP " + httpCode + ": " + response.getContentText()
      );
      continue;
    }

    assertFirestoreResponse_(response, "batchWrite (" + subChunk.length + " escrituras)");

    // batchWrite responde 200 aunque fallen escrituras puntuales: revisar status.
    const payload = JSON.parse(response.getContentText() || "{}");
    const statuses = payload.status || [];

    const stillPending = [];
    for (let j = 0; j < pending.length; j += 1) {
      const status = statuses[j] || {};
      if (!status.code) continue; // escritura OK

      const writeIndex = baseIndex + pending[j];
      const docRef = chunk[pending[j]].update
        ? chunk[pending[j]].update.name
        : chunk[pending[j]].delete;

      if (isRetryableFirestoreCode_(status.code)) {
        stillPending.push(pending[j]);
        lastError = new Error(
          "batchWrite throttled en la escritura " +
            writeIndex +
            " (" +
            JSON.stringify(docRef) +
            "): " +
            (status.message || JSON.stringify(status))
        );
      } else {
        // Error no transitorio (datos invalidos, permisos, etc.): abortar.
        throw new Error(
          "batchWrite fallo en la escritura " +
            writeIndex +
            " (" +
            JSON.stringify(docRef) +
            "): " +
            (status.message || JSON.stringify(status))
        );
      }
    }

    if (stillPending.length === 0) return; // lote completo confirmado
    pending = stillPending;
  }

  throw new Error(
    "batchWrite agoto los reintentos (" +
      pending.length +
      " escrituras pendientes por throttling). Ultimo error: " +
      (lastError ? lastError.message : "desconocido")
  );
}

function setFirestoreDocument_(collectionName, docId, payload) {
  const url = firestoreDocumentUrl_(collectionName, docId, Object.keys(payload || {}));
  const accessToken = getFirestoreAccessToken_();
  const response = UrlFetchApp.fetch(url, {
    method: "patch",
    contentType: "application/json",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Content-Type": "application/json",
    },
    payload: JSON.stringify({ fields: encodeFirestoreFields_(payload || {}) }),
    muteHttpExceptions: true,
  });

  assertFirestoreResponse_(response, "guardar " + collectionName + "/" + docId);
}

function replaceFirestoreDocument_(collectionName, docId, payload) {
  const url = firestoreDocumentUrl_(collectionName, docId, []);
  const response = UrlFetchApp.fetch(url, {
    method: "patch",
    contentType: "application/json",
    headers: {
      Authorization: "Bearer " + getFirestoreAccessToken_(),
      "Content-Type": "application/json",
    },
    payload: JSON.stringify({ fields: encodeFirestoreFields_(payload || {}) }),
    muteHttpExceptions: true,
  });
  assertFirestoreResponse_(response, "reemplazar " + collectionName + "/" + docId);
}

function deleteFirestoreDocument_(collectionName, docId) {
  const url =
    firestoreBaseUrl_() +
    "/documents/" +
    encodeURIComponent(collectionName) +
    "/" +
    encodeURIComponent(docId);
  const response = UrlFetchApp.fetch(url, {
    method: "delete",
    headers: {
      Authorization: "Bearer " + getFirestoreAccessToken_(),
      "Content-Type": "application/json",
    },
    muteHttpExceptions: true,
  });

  assertFirestoreResponse_(response, "eliminar " + collectionName + "/" + docId);
}

function listFirestoreCollection_(collectionName) {
  const docs = [];
  let pageToken = "";

  do {
    let url =
      firestoreBaseUrl_() +
      "/documents/" +
      encodeURIComponent(collectionName) +
      "?pageSize=1000";

    if (pageToken) {
      url += "&pageToken=" + encodeURIComponent(pageToken);
    }

    const response = UrlFetchApp.fetch(url, {
      method: "get",
      headers: {
        Authorization: "Bearer " + getFirestoreAccessToken_(),
        "Content-Type": "application/json",
      },
      muteHttpExceptions: true,
    });

    assertFirestoreResponse_(response, "leer coleccion " + collectionName);

    const payload = JSON.parse(response.getContentText() || "{}");
    (payload.documents || []).forEach(function (doc) {
      const parts = String(doc.name || "").split("/");
      docs.push({
        id: parts[parts.length - 1],
        data: decodeFirestoreFields_(doc.fields || {}),
      });
    });
    pageToken = payload.nextPageToken || "";
  } while (pageToken);

  return docs;
}

function firestoreDocumentUrl_(collectionName, docId, updateMaskFields) {
  let url =
    firestoreBaseUrl_() +
    "/documents/" +
    encodeURIComponent(collectionName) +
    "/" +
    encodeURIComponent(docId);

  (updateMaskFields || []).forEach(function (field) {
    url += (url.indexOf("?") === -1 ? "?" : "&") + "updateMask.fieldPaths=" + encodeURIComponent(field);
  });

  return url;
}

function firestoreBaseUrl_() {
  return "https://firestore.googleapis.com/v1/projects/" + encodeURIComponent(getFirebaseProjectId_()) + "/databases/(default)";
}

function getFirebaseProjectId_() {
  return getRequiredScriptProperty_("FIREBASE_PROJECT_ID");
}

function getFirestoreAccessToken_(options) {
  options = options || {};
  const projectId = getFirebaseProjectId_();
  const clientEmail = getRequiredScriptProperty_("FIREBASE_CLIENT_EMAIL");
  const cacheKey = "firestore_access_token_" + slugify_(projectId + "_" + clientEmail).slice(0, 180);
  const cache = CacheService.getScriptCache();
  const cached = options.forceRefresh ? "" : cache.get(cacheKey);
  if (cached) return cached;

  const privateKey = getRequiredScriptProperty_("FIREBASE_PRIVATE_KEY").replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
  };
  const claim = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const unsignedJwt =
    base64UrlEncode_(JSON.stringify(header)) + "." + base64UrlEncode_(JSON.stringify(claim));
  const signature = Utilities.computeRsaSha256Signature(unsignedJwt, privateKey);
  const jwt = unsignedJwt + "." + base64UrlEncode_(signature);
  const response = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
    method: "post",
    payload: {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    },
    muteHttpExceptions: true,
  });

  assertFirestoreResponse_(response, "obtener token OAuth");

  const payload = JSON.parse(response.getContentText() || "{}");
  if (!payload.access_token) {
    throw new Error("Firebase no devolvio access_token.");
  }

  cache.put(cacheKey, payload.access_token, 3300);
  return payload.access_token;
}

function getRequiredScriptProperty_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) {
    throw new Error("Falta configurar Script Property: " + key);
  }
  return value;
}

function assertFirestoreResponse_(response, action) {
  const code = response.getResponseCode();
  if (code >= 200 && code < 300) return;

  throw new Error(
    "Error al " +
      action +
      " en Firestore. HTTP " +
      code +
      ": " +
      response.getContentText()
  );
}

function safeParseJson_(text) {
  const safeText = String(text || "");
  if (!safeText) return null;

  try {
    return JSON.parse(safeText);
  } catch (error) {
    return safeText;
  }
}

function encodeFirestoreFields_(obj) {
  const fields = {};
  Object.keys(obj || {}).forEach(function (key) {
    if (obj[key] !== undefined) {
      fields[key] = encodeFirestoreValue_(obj[key]);
    }
  });
  return fields;
}

function encodeFirestoreValue_(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    if (Math.floor(value) === value) return { integerValue: String(value) };
    return { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map(encodeFirestoreValue_),
      },
    };
  }
  if (typeof value === "object") {
    return {
      mapValue: {
        fields: encodeFirestoreFields_(value),
      },
    };
  }
  return { stringValue: String(value) };
}

function decodeFirestoreFields_(fields) {
  const obj = {};
  Object.keys(fields || {}).forEach(function (key) {
    obj[key] = decodeFirestoreValue_(fields[key]);
  });
  return obj;
}

function decodeFirestoreValue_(value) {
  if (!value || typeof value !== "object") return null;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("booleanValue" in value) return value.booleanValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("nullValue" in value) return null;
  if ("arrayValue" in value) {
    return (value.arrayValue.values || []).map(decodeFirestoreValue_);
  }
  if ("mapValue" in value) {
    return decodeFirestoreFields_(value.mapValue.fields || {});
  }
  return null;
}

function base64UrlEncode_(value) {
  const bytes = typeof value === "string" ? Utilities.newBlob(value).getBytes() : value;
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, "");
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

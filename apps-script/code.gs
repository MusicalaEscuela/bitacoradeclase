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
  if (!lock.tryLock(30000)) {
    throw new Error("Ya hay una sincronizacion de estudiantes en curso.");
  }

  const startedAt = new Date();
  const report = createSyncReport_(startedAt);

  try {
    const studentsReport = syncStudentsSheetToFirestore({ report: report });
    const usersReport = syncStudentAccessUsersToFirestore({
      report: report,
      students: studentsReport.students,
    });

    report.students = stripInternalSyncReport_(studentsReport);
    report.users = stripInternalSyncReport_(usersReport);
    report.synced = report.created + report.updated;
    report.finishedAt = new Date().toISOString();
    report.ok = true;

    saveSyncReportToFirestore_(report);
    return report;
  } catch (error) {
    report.ok = false;
    report.error = error && error.message ? error.message : String(error);
    report.finishedAt = new Date().toISOString();

    try {
      saveSyncReportToFirestore_(report);
    } catch (saveError) {
      console.error("No se pudo guardar el reporte de sincronizacion:", saveError);
    }

    try {
      sendSyncFailureAlert_(report);
    } catch (mailError) {
      console.error("No se pudo enviar la alerta de fallo:", mailError);
    }

    throw error;
  } finally {
    lock.releaseLock();
  }
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
      const memberKey = String(member.studentKey || member.id || member.studentId || "").trim();
      if (memberKey) idsMap[memberKey] = true;
    });
    const studentIds = Object.keys(idsMap).sort();
    const studentKey = String(primary.studentKey || primary.id || primary.studentId || "").trim();

    const now = new Date().toISOString();
    const payload = {
      email: email,
      role: "student",
      studentId: studentKey,
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

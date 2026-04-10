import { CONFIG } from "./config.js";
import { toStringSafe } from "./utils/shared.js";

export function normalizeRole(role) {
  const safeRole = toStringSafe(role).toLowerCase();

  if (safeRole === CONFIG.roles.admin) return CONFIG.roles.admin;
  if (safeRole === CONFIG.roles.teacher) return CONFIG.roles.teacher;
  if (safeRole === CONFIG.roles.student) return CONFIG.roles.student;
  return "";
}

export function resolveUserAccess(user = null) {
  if (!user?.uid) {
    return {
      role: "guest",
      linkedStudentId: "",
      canManageSettings: false,
      canEditBitacoras: false,
      canEditRoutes: false,
      canViewSearch: false,
      canUseGroupBitacoras: false,
    };
  }

  const email = toStringSafe(user.email).toLowerCase();
  const bootstrapAdmins = Array.isArray(CONFIG.access?.bootstrapAdminEmails)
    ? CONFIG.access.bootstrapAdminEmails.map((item) => toStringSafe(item).toLowerCase())
    : [];

  const explicitRole = normalizeRole(user.role);
  const linkedStudentId = toStringSafe(
    user.linkedStudentId || user.studentId || user.studentKey
  );

  const role =
    bootstrapAdmins.includes(email)
      ? CONFIG.roles.admin
      : linkedStudentId && explicitRole !== CONFIG.roles.admin
      ? CONFIG.roles.student
      : explicitRole;

  const isAllowedStudent =
    role !== CONFIG.roles.student || user?.active === true;

  if (role === CONFIG.roles.admin) {
    return {
      role,
      linkedStudentId,
      canManageSettings: true,
      canEditBitacoras: true,
      canEditRoutes: true,
      canViewSearch: true,
      canUseGroupBitacoras: true,
    };
  }

  if (role === CONFIG.roles.student && isAllowedStudent) {
    return {
      role,
      linkedStudentId,
      canManageSettings: false,
      canEditBitacoras: false,
      canEditRoutes: false,
      canViewSearch: false,
      canUseGroupBitacoras: false,
    };
  }

  if (role === CONFIG.roles.teacher) {
    return {
      role: CONFIG.roles.teacher,
      linkedStudentId: linkedStudentId || "",
      canManageSettings: false,
      canEditBitacoras: true,
      canEditRoutes: true,
      canViewSearch: true,
      canUseGroupBitacoras: true,
    };
  }

  return {
    role: "unauthorized",
    linkedStudentId: "",
    canManageSettings: false,
    canEditBitacoras: false,
    canEditRoutes: false,
    canViewSearch: false,
    canUseGroupBitacoras: false,
  };
}

export function canViewStudent(user, studentRef) {
  const access = resolveUserAccess(user);
  const safeRef = toStringSafe(studentRef);

  if (!safeRef) return false;
  if (access.role === "guest") return false;
  if (access.role === CONFIG.roles.student) {
    return toStringSafe(access.linkedStudentId) === safeRef;
  }

  return true;
}

export function getDefaultViewForUser(user) {
  const access = resolveUserAccess(user);
  return access.role === CONFIG.roles.student
    ? CONFIG.routes.profile
    : CONFIG.routes.search;
}

export function canAccessRoute(user, routeName) {
  const access = resolveUserAccess(user);
  const route = toStringSafe(routeName);

  if (route === CONFIG.routes.settings) {
    return access.canManageSettings;
  }

  if (route === CONFIG.routes.search) {
    return access.canViewSearch;
  }

  if (route === CONFIG.routes.libraries) {
    return access.role !== "guest";
  }

  if (route === CONFIG.routes.editor) {
    return access.canEditBitacoras;
  }

  if (route === CONFIG.routes.profile) {
    return access.role !== "guest";
  }

  return access.role !== "guest";
}

export function getRoleLabel(role) {
  const safeRole = normalizeRole(role);
  if (safeRole === CONFIG.roles.admin) return "Admin";
  if (safeRole === CONFIG.roles.student) return "Estudiante";
  if (safeRole === CONFIG.roles.teacher) return "Docente";
  if (toStringSafe(role) === "unauthorized") return "Sin acceso";
  return "Usuario";
}

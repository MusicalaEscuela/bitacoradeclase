import { CONFIG } from "./config.js";
import { toStringSafe } from "./utils/shared.js";

export function normalizeRole(role) {
  const safeRole = toStringSafe(role).toLowerCase();

  if (safeRole === CONFIG.roles.admin) return CONFIG.roles.admin;
  if (safeRole === CONFIG.roles.teacher) return CONFIG.roles.teacher;
  if (safeRole === "docente") return CONFIG.roles.teacher;
  return "unauthorized";
}

export function resolveUserAccess(user = null) {
  if (!user?.uid) {
    return {
      role: "guest",
      linkedStudentId: "",
      canManageSettings: false,
      canEditBitacoras: false,
      canEditRouteStructure: false,
      canUpdateRouteProgress: false,
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
  const isActive = user?.active !== false;

  const role =
    bootstrapAdmins.includes(email)
      ? CONFIG.roles.admin
      : explicitRole;

  if (role === CONFIG.roles.admin && (bootstrapAdmins.includes(email) || isActive)) {
    return {
      role,
      linkedStudentId: "",
      canManageSettings: true,
      canEditBitacoras: true,
      canEditRouteStructure: true,
      canUpdateRouteProgress: true,
      canEditRoutes: true,
      canViewSearch: true,
      canUseGroupBitacoras: true,
    };
  }

  if (role === CONFIG.roles.teacher && isActive) {
    return {
      role: CONFIG.roles.teacher,
      linkedStudentId: "",
      canManageSettings: false,
      canEditBitacoras: true,
      canEditRouteStructure: false,
      canUpdateRouteProgress: true,
      canEditRoutes: false,
      canViewSearch: true,
      canUseGroupBitacoras: true,
    };
  }

  return {
    role: "unauthorized",
    linkedStudentId: "",
    canManageSettings: false,
    canEditBitacoras: false,
    canEditRouteStructure: false,
    canUpdateRouteProgress: false,
    canEditRoutes: false,
    canViewSearch: false,
    canUseGroupBitacoras: false,
  };
}

export function canViewStudent(user, studentRef) {
  const access = resolveUserAccess(user);
  const safeRef = toStringSafe(studentRef);

  if (!safeRef) return false;
  return access.role === CONFIG.roles.admin || access.role === CONFIG.roles.teacher;
}

export function getDefaultViewForUser(user) {
  const access = resolveUserAccess(user);
  if (access.role === CONFIG.roles.admin || access.role === CONFIG.roles.teacher) {
    return CONFIG.routes.search;
  }
  return CONFIG.routes.search;
}

export function canAccessRoute(user, routeName) {
  const access = resolveUserAccess(user);
  const route = toStringSafe(routeName);

  if (route === CONFIG.routes.settings) {
    return access.canManageSettings;
  }

  if (route === CONFIG.routes.search) {
    return access.canViewSearch || access.role === "guest";
  }

  if (route === CONFIG.routes.editor) {
    return access.canEditBitacoras;
  }

  if (route === CONFIG.routes.compare) {
    return access.role === CONFIG.roles.admin || access.role === CONFIG.roles.teacher;
  }

  if (route === CONFIG.routes.planeador) {
    return access.role === CONFIG.roles.admin || access.role === CONFIG.roles.teacher;
  }

  if (route === CONFIG.routes.profile) {
    return access.role === CONFIG.roles.admin || access.role === CONFIG.roles.teacher;
  }

  return access.role === CONFIG.roles.admin || access.role === CONFIG.roles.teacher;
}

export function getRoleLabel(role) {
  const safeRole = normalizeRole(role);
  if (safeRole === CONFIG.roles.admin) return "Admin";
  if (safeRole === CONFIG.roles.teacher) return "Docente";
  if (toStringSafe(role) === "guest") return "Invitado";
  return "Sin acceso";
}

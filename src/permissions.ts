import type { Request } from 'express';
import { pool } from './db.js';
import { ApiError, asyncHandler } from './http.js';

export type ModulePermissions = {
  dashboard: 'none' | 'read' | 'write';
  habitaciones: 'none' | 'read' | 'write';
  reservas: 'none' | 'read' | 'write';
  extractor: 'none' | 'read' | 'write';
  pagos: 'none' | 'read' | 'write';
  tarifas: 'none' | 'read' | 'write';
  huespedes: 'none' | 'read' | 'write';
  personal: 'none' | 'read' | 'write';
  hoteles: 'none' | 'read' | 'write';
  reportes: 'none' | 'read' | 'write';
  calculadora: 'none' | 'read' | 'write';
  auditoria: 'none' | 'read' | 'write';
  configuracion: 'none' | 'read' | 'write';
  accesos: 'none' | 'read' | 'write';
  perfil: 'none' | 'read' | 'write';
};

export const extractUserId = (request: Request) => {
  const header = request.headers['x-user-id'];
  const userId = typeof header === 'string' ? header : null;
  if (userId) {
    // identity logged
  }
  return userId;
};

async function getUserPermissions(userId: string): Promise<{ role: string; permissions: ModulePermissions } | null> {
  try {
    const result = await pool.query(
      `
      SELECT 
        coalesce(u.raw_app_meta_data ->> 'role', u.raw_user_meta_data ->> 'role', 'admin') as role,
        coalesce(u.raw_app_meta_data -> 'permissions', '{}'::jsonb) as permissions
      FROM auth.users u
      WHERE u.id = $1
      `,
      [userId],
    );

    if (result.rowCount === 0) return null;

    const row = result.rows[0];
    return {
      role: row.role ?? 'admin',
      permissions: row.permissions as ModulePermissions,
    };
  } catch (err) {
    console.error(`[Permissions] Error fetching permissions for user ${userId}:`, err);
    return null;
  }
}

export const requirePermission = (module: keyof ModulePermissions, level: 'read' | 'write') => {
  return asyncHandler(async (request, _response, next) => {
    const userId = extractUserId(request);
    if (!userId) {
      throw new ApiError(401, 'No autenticado. x-user-id faltante.');
    }

    const profile = await getUserPermissions(userId);
    if (!profile) {
      throw new ApiError(403, 'Usuario no encontrado o sin perfil de acceso.');
    }

    if (profile.role === 'super_admin') {
      return next();
    }

    const currentLevel = profile.permissions[module] ?? 'none';
    const hasAccess =
      (level === 'read' && (currentLevel === 'read' || currentLevel === 'write')) ||
      (level === 'write' && currentLevel === 'write');

    if (!hasAccess) {
      console.warn(`[Security] Access denied for user ${userId} on ${module}:${level}. User has: ${currentLevel}`);
      throw new ApiError(403, `Acceso denegado. Se requiere permiso de ${level} en el módulo ${module}.`);
    }

    next();
  });
};
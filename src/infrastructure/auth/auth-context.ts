/**
 * AuthContext — perfil resuelto del request autenticado.
 *
 * Inyectado en `req.auth` por el `SupabaseAuthGuard` cuando un JWT
 * válido entra. Los decoradores `@CurrentUser()` y `@CurrentCompany()`
 * lo extraen para que los controllers no toquen `req` directo.
 *
 * Durante el período de migración (PR 2..5), si `DEV_AUTH_BYPASS=true`,
 * el guard puebla esto con valores mínimos derivados del header
 * `X-Company-Id` (compat con el path actual sin JWT).
 */
export interface AuthContext {
  /** `auth.users.id` de Supabase. */
  userId: string | null;
  /** `employees.id` del empleado linkeado al user. */
  employeeId: string | null;
  /** Tenant — siempre presente cuando el guard deja pasar. */
  companyId: string;
  /** 'owner' | 'manager' | 'employee' — derivado de `employees.role`. */
  role: 'owner' | 'manager' | 'employee' | null;
  /** `employees.department_id`. */
  departmentId: string | null;
}

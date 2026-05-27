/**
 * Capability catalog — fuente de verdad de los strings que se persisten
 * en `company_role_capabilities` y `employee_capabilities`.
 *
 * Agregar una capability acá NO la activa automáticamente; hay que:
 *   1. Sumarla a `CAPABILITIES` con su descripción y default-roles
 *   2. Sumarla al INSERT del trigger `seed_default_role_capabilities`
 *      (próxima migration) o al seed manual de companies existentes
 *   3. Aplicar el decorador `@Requires('<cap>')` en el endpoint que la
 *      necesita
 *
 * Convención de naming: `<resource>:<verb>` o `<resource>:<modifier>_<verb>`.
 *   - resource: branches, departments, employees, schedule, swaps, etc.
 *   - verb:     read, write, manage, generate, approve
 *   - modifier: wages, etc.
 */

export const CAPABILITIES = {
  // Billing & ownership ─────────────────────────────────────────────
  'billing:manage': {
    description: 'Manage subscription, invoices, payment method',
    defaultRoles: ['owner'],
  },
  'settings:manage': {
    description: 'Edit company-level settings (timezone, week start, etc.)',
    defaultRoles: ['owner'],
  },
  'team:assign_scope': {
    description: 'Assign managers to branches/departments',
    defaultRoles: ['owner'],
  },
  'team:grant_capability': {
    description: 'Grant individual users extra capabilities ("owner-like")',
    defaultRoles: ['owner'],
  },

  // Workspace structure ─────────────────────────────────────────────
  'branches:write': {
    description: 'Create/edit/delete branches',
    defaultRoles: ['owner'],
  },
  'departments:write': {
    description: 'Create/edit/delete departments (scoped for managers)',
    defaultRoles: ['owner', 'manager'],
  },

  // People ──────────────────────────────────────────────────────────
  'employees:write': {
    description: 'Create/edit employees (scoped for managers)',
    defaultRoles: ['owner', 'manager'],
  },
  'employees:wages_read': {
    description: 'View employee wages/salary info',
    defaultRoles: ['owner'],
  },

  // Policies & rules ────────────────────────────────────────────────
  'policies:write': {
    description: 'Create/edit company policies + semantic rules',
    defaultRoles: ['owner'],
  },
  'policies:read': {
    description: 'View policies + rules',
    defaultRoles: ['owner', 'manager'],
  },

  // Scheduling ──────────────────────────────────────────────────────
  'schedule:generate': {
    description: 'Trigger AI schedule generation',
    defaultRoles: ['owner', 'manager'],
  },
  'schedule:write': {
    description: 'Edit shift assignments (scoped for managers)',
    defaultRoles: ['owner', 'manager'],
  },

  // Approvals ───────────────────────────────────────────────────────
  'swaps:approve': {
    description: 'Approve/reject shift swap requests',
    defaultRoles: ['owner', 'manager'],
  },
  'absences:approve': {
    description: 'Approve/reject absence reports',
    defaultRoles: ['owner', 'manager'],
  },
  'incidents:manage': {
    description: 'Manage incidents (resolve, close)',
    defaultRoles: ['owner', 'manager'],
  },
  'dayoffs:approve': {
    description: 'Approve/reject day-off requests',
    defaultRoles: ['owner', 'manager'],
  },

  // Observability ───────────────────────────────────────────────────
  'audit:read': {
    description: 'View audit log (security events)',
    defaultRoles: ['owner', 'manager', 'employee'],
  },

  // Data import ─────────────────────────────────────────────────────
  'imports:run': {
    description:
      'Run multi-modal data imports (employees, shifts, time-off via upload/Excel/external agent)',
    defaultRoles: ['owner'],
  },
} as const;

export type Capability = keyof typeof CAPABILITIES;

/** Lista de capabilities scoped (filtran por dept_id del recurso target).
 * Las que no están acá son company-wide (no aplica scope check). */
export const SCOPED_CAPABILITIES: ReadonlySet<Capability> = new Set([
  'departments:write',
  'employees:write',
  'schedule:write',
  'swaps:approve',
  'absences:approve',
  'incidents:manage',
  'dayoffs:approve',
]);

/** Devuelve el set default de capabilities por rol — usado para seeds. */
export function defaultsForRole(
  role: 'owner' | 'manager' | 'employee',
): Capability[] {
  return (
    Object.entries(CAPABILITIES) as [
      Capability,
      { defaultRoles: readonly string[] },
    ][]
  )
    .filter(([, def]) => def.defaultRoles.includes(role))
    .map(([cap]) => cap);
}

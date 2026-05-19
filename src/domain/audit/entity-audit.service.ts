import type {
  AuditAction,
  ChangeSet,
  EntityAuditEntry,
  EntityType,
} from './entity-audit.types';

export const ENTITY_AUDIT_SERVICE = Symbol('ENTITY_AUDIT_SERVICE');

export interface LogParams {
  companyId: string;
  entityType: EntityType;
  entityId: string;
  action: AuditAction;
  changes: ChangeSet;
  actorUserId?: string | null;
  actorEmployeeId?: string | null;
}

/**
 * IEntityAuditService — Port (Domain Layer).
 *
 * Cross-cutting log de cambios sobre entidades editables. Los controllers
 * lo invocan después de un write exitoso. Si `changes` es un objeto vacío
 * (no hubo deltas), la implementación debería no-op para evitar ruido.
 */
export interface IEntityAuditService {
  log(params: LogParams): Promise<void>;

  list(
    companyId: string,
    entityType: EntityType,
    entityId: string,
  ): Promise<EntityAuditEntry[]>;
}

/**
 * Helper para computar el changeset entre 2 snapshots planos. Itera sobre
 * `fields` (la lista de campos editables) y deja afuera del resultado los
 * que no cambiaron (deep-equal por JSON.stringify para tolerar arrays /
 * objects sin importar la referencia).
 *
 * Asume valores serializables. Para Dates pasar `.toISOString()` antes.
 */
export function computeChangeSet<T extends Record<string, unknown>>(
  before: T,
  after: T,
  fields: readonly (keyof T)[],
): ChangeSet {
  const out: ChangeSet = {};
  for (const f of fields) {
    const a = before[f];
    const b = after[f];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out[String(f)] = { before: a ?? null, after: b ?? null };
    }
  }
  return out;
}

/**
 * Snapshot completo serializado como ChangeSet. Útil para action='create'
 * (before vacío, after es el snapshot) y action='delete' (al revés).
 */
export function snapshotAsChangeSet(
  snapshot: Record<string, unknown>,
  direction: 'create' | 'delete',
): ChangeSet {
  const out: ChangeSet = {};
  for (const [k, v] of Object.entries(snapshot)) {
    if (direction === 'create') {
      out[k] = { before: null, after: v ?? null };
    } else {
      out[k] = { before: v ?? null, after: null };
    }
  }
  return out;
}

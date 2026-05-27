/**
 * Schema canónico v1.0.0 al que las 3 vías de importación convergen.
 *
 * Sprint Data Import Fase 1. La validación runtime vive en
 * `interfaces/dtos/imports/*.dto.ts` (class-validator) — estos types son
 * el contrato de domain + lo que el JSONB de `imports_staging.payload`
 * promete.
 *
 * Reglas universales:
 *   - Nunca inventar campos: si la fuente no lo dice, omitilo (`undefined`).
 *   - Referencias intra-payload por `externalId` (string libre único en
 *     el lote). El committer mapea a UUIDs reales en confirm.
 *   - `confidence` 0..1 por entidad. Umbral auto-aceptar viene de
 *     `companies.imports_confidence_threshold` (default 0.85).
 *   - Cross-midnight: shift con `crossesMidnight=true` significa que
 *     `endTime` es del día siguiente al `date`.
 */

export const IMPORT_SCHEMA_VERSION = '1.0.0' as const;

export type ImportSource =
  | 'upload_freeform'
  | 'template_excel'
  | 'external_agent';

export type ImportStagingStatus =
  | 'pending_review'
  | 'confirming'
  | 'committed'
  | 'failed'
  | 'discarded';

export interface ImportSourceMetadata {
  extractedAt: string; // ISO 8601 datetime
  agentName?: string; // "claude-sonnet-4-6", "user-paste", etc.
  agentVersion?: string;
  confidence?: number; // 0..1, confianza global del lote
  notes?: string;
}

export interface ImportPayload {
  schemaVersion: typeof IMPORT_SCHEMA_VERSION;
  source: ImportSource;
  sourceMetadata: ImportSourceMetadata;
  data: ImportData;
  warnings?: ImportWarning[];
  unresolvedReferences?: UnresolvedReference[];
}

export interface ImportData {
  locations?: ImportLocation[];
  departments?: ImportDepartment[];
  roles?: ImportRole[];
  employees?: ImportEmployee[];
  shifts?: ImportShift[];
  availability?: ImportAvailability[];
  breaks?: ImportBreak[];
  timeOff?: ImportTimeOff[];
}

// ─── Entidades ─────────────────────────────────────────────────────────

export interface ImportLocation {
  externalId: string;
  name: string;
  /** IANA tz; si falta, el committer usa el de la company. */
  timezone?: string;
  confidence?: number;
}

export interface ImportDepartment {
  externalId: string;
  name: string;
  locationExternalId?: string;
  managerEmployeeExternalId?: string;
  confidence?: number;
}

/** Mapea 1:1 a `company_skills` del orchestrator. */
export interface ImportRole {
  externalId: string;
  name: string;
  confidence?: number;
}

export type EmploymentType =
  | 'full_time'
  | 'part_time'
  | 'contractor'
  | 'intern';

export interface PayRate {
  amount: number;
  /** ISO 4217 — "USD", "ARS", etc. */
  currency: string;
  period: 'hour' | 'week' | 'month';
}

export interface ImportEmployee {
  externalId: string;
  name: string;
  email?: string;
  /** E.164 ("+15551234567"). El parser de cada vía valida o descarta. */
  phone?: string;
  /** ISO 8601 YYYY-MM-DD. */
  hireDate?: string;
  employmentType?: EmploymentType;
  payRate?: PayRate;
  departmentExternalId?: string;
  roleExternalIds?: string[];
  experienceMonths?: number;
  confidence?: number;
}

export interface ImportShift {
  externalId: string;
  /** Si falta → open shift. */
  employeeExternalId?: string;
  templateName?: string;
  /** YYYY-MM-DD del día de inicio. */
  date: string;
  /** HH:mm 24h, wall-clock del tenant. */
  startTime: string;
  endTime: string;
  crossesMidnight: boolean;
  locationExternalId?: string;
  departmentExternalId?: string;
  requiredRoleExternalId?: string;
  confidence?: number;
}

export interface AvailabilityWindow {
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  available: boolean;
}

export interface ImportAvailability {
  externalId: string;
  employeeExternalId: string;
  /** JS Date.getDay() convention: 0=Sun ... 6=Sat. */
  dayOfWeek: number;
  windows: AvailabilityWindow[];
  effectiveFrom?: string;
  effectiveUntil?: string;
  confidence?: number;
}

export type BreakScope =
  | 'policy_global'
  | 'policy_role'
  | 'shift_specific';

export interface ImportBreak {
  externalId: string;
  scope: BreakScope;
  triggerAfterMinutesWorked?: number;
  durationMinutes: number;
  isPaid: boolean;
  /** Requerido si scope='policy_role'. */
  roleExternalId?: string;
  /** Requerido si scope='shift_specific'. */
  shiftExternalId?: string;
  confidence?: number;
}

export type TimeOffType =
  | 'vacation'
  | 'sick'
  | 'personal'
  | 'unpaid'
  | 'other';

export interface ImportTimeOff {
  externalId: string;
  employeeExternalId: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;
  type: TimeOffType;
  reason?: string;
  status: 'approved' | 'pending' | 'rejected';
  confidence?: number;
}

// ─── Warnings + Unresolved ─────────────────────────────────────────────

export type WarningSeverity = 'info' | 'warn' | 'error';

export interface EntityRef {
  entity: keyof ImportData;
  externalId: string;
}

export interface ImportWarning {
  severity: WarningSeverity;
  /** Stable code, e.g. "EMPLOYEE_EMAIL_MISSING". */
  code: string;
  /** i18n key opcional ("imports:errors.EMPLOYEE_EMAIL_MISSING"). */
  messageKey?: string;
  /** Texto humano EN fallback. */
  message: string;
  entityRef?: EntityRef;
  suggestion?: string;
}

export interface UnresolvedReferenceCandidate {
  /** ID real en DB. */
  id: string;
  label: string;
  confidence: number;
}

export interface UnresolvedReference {
  fromEntity: keyof ImportData;
  fromExternalId: string;
  field: string;
  rawValue: string;
  candidates?: UnresolvedReferenceCandidate[];
}

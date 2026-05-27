import { Injectable } from '@nestjs/common';
import type {
  ImportPayload,
  ImportWarning,
} from '../../domain/imports/import-payload.types';

/**
 * ImportValidator — chequeos cross-entity sobre un payload ya parseado
 * por class-validator. Lo que validamos acá:
 *   - Unicidad de externalIds dentro de cada tipo de entidad.
 *   - FKs intra-payload (ej. shift.employeeExternalId existe en
 *     employees del mismo payload, o queda como unresolved).
 *   - cross-midnight coherente (endTime ≤ startTime ⇒ crossesMidnight=true).
 *   - employee email/phone duplicados dentro del payload.
 *   - timeOff con startDate > endDate.
 *
 * Side-effect-free: devuelve `warnings[]` adicionales. No muta el
 * payload. El committer decide qué hacer con warnings de severity
 * 'error' (skip esa fila).
 */
@Injectable()
export class ImportValidatorService {
  validate(payload: ImportPayload): ImportWarning[] {
    const warnings: ImportWarning[] = [];

    this.checkExternalIdUniqueness(payload, warnings);
    this.checkIntraPayloadFks(payload, warnings);
    this.checkShiftTimes(payload, warnings);
    this.checkEmployeeUniqueness(payload, warnings);
    this.checkTimeOffRanges(payload, warnings);

    return warnings;
  }

  private checkExternalIdUniqueness(
    payload: ImportPayload,
    warnings: ImportWarning[],
  ): void {
    const entities: Array<keyof ImportPayload['data']> = [
      'locations',
      'departments',
      'roles',
      'employees',
      'shifts',
      'availability',
      'breaks',
      'timeOff',
    ];
    for (const entity of entities) {
      const rows = payload.data[entity] as
        | Array<{ externalId: string }>
        | undefined;
      if (!rows) continue;
      const seen = new Set<string>();
      for (const r of rows) {
        if (seen.has(r.externalId)) {
          warnings.push({
            severity: 'error',
            code: 'IMPORT_DUPLICATE_EXTERNAL_ID',
            message: `Duplicate externalId "${r.externalId}" within ${entity}`,
            entityRef: { entity, externalId: r.externalId },
          });
        }
        seen.add(r.externalId);
      }
    }
  }

  private checkIntraPayloadFks(
    payload: ImportPayload,
    warnings: ImportWarning[],
  ): void {
    const empIds = new Set(
      (payload.data.employees ?? []).map((e) => e.externalId),
    );
    const deptIds = new Set(
      (payload.data.departments ?? []).map((d) => d.externalId),
    );
    const roleIds = new Set(
      (payload.data.roles ?? []).map((r) => r.externalId),
    );
    const locIds = new Set(
      (payload.data.locations ?? []).map((l) => l.externalId),
    );

    // Shifts → employee
    for (const s of payload.data.shifts ?? []) {
      if (s.employeeExternalId && !empIds.has(s.employeeExternalId)) {
        warnings.push({
          severity: 'warn',
          code: 'IMPORT_SHIFT_EMPLOYEE_NOT_IN_PAYLOAD',
          message: `Shift ${s.externalId} references employee "${s.employeeExternalId}" not present in this payload`,
          entityRef: { entity: 'shifts', externalId: s.externalId },
          suggestion:
            'The committer will try to match against existing employees in the database.',
        });
      }
      if (
        s.requiredRoleExternalId &&
        !roleIds.has(s.requiredRoleExternalId)
      ) {
        warnings.push({
          severity: 'warn',
          code: 'IMPORT_SHIFT_ROLE_NOT_IN_PAYLOAD',
          message: `Shift ${s.externalId} requires role "${s.requiredRoleExternalId}" not in payload`,
          entityRef: { entity: 'shifts', externalId: s.externalId },
        });
      }
      if (s.departmentExternalId && !deptIds.has(s.departmentExternalId)) {
        warnings.push({
          severity: 'warn',
          code: 'IMPORT_SHIFT_DEPT_NOT_IN_PAYLOAD',
          message: `Shift ${s.externalId} references department "${s.departmentExternalId}" not in payload`,
          entityRef: { entity: 'shifts', externalId: s.externalId },
        });
      }
      if (s.locationExternalId && !locIds.has(s.locationExternalId)) {
        warnings.push({
          severity: 'warn',
          code: 'IMPORT_SHIFT_LOCATION_NOT_IN_PAYLOAD',
          message: `Shift ${s.externalId} references location "${s.locationExternalId}" not in payload`,
          entityRef: { entity: 'shifts', externalId: s.externalId },
        });
      }
    }

    // Employees → role(s) y dept
    for (const e of payload.data.employees ?? []) {
      if (e.departmentExternalId && !deptIds.has(e.departmentExternalId)) {
        warnings.push({
          severity: 'warn',
          code: 'IMPORT_EMPLOYEE_DEPT_NOT_IN_PAYLOAD',
          message: `Employee ${e.externalId} references department "${e.departmentExternalId}" not in payload`,
          entityRef: { entity: 'employees', externalId: e.externalId },
        });
      }
      for (const rid of e.roleExternalIds ?? []) {
        if (!roleIds.has(rid)) {
          warnings.push({
            severity: 'warn',
            code: 'IMPORT_EMPLOYEE_ROLE_NOT_IN_PAYLOAD',
            message: `Employee ${e.externalId} references role "${rid}" not in payload`,
            entityRef: { entity: 'employees', externalId: e.externalId },
          });
        }
      }
    }

    // Availability → employee
    for (const a of payload.data.availability ?? []) {
      if (!empIds.has(a.employeeExternalId)) {
        warnings.push({
          severity: 'warn',
          code: 'IMPORT_AVAILABILITY_EMPLOYEE_NOT_IN_PAYLOAD',
          message: `Availability ${a.externalId} references employee "${a.employeeExternalId}" not in payload`,
          entityRef: { entity: 'availability', externalId: a.externalId },
        });
      }
    }

    // TimeOff → employee
    for (const t of payload.data.timeOff ?? []) {
      if (!empIds.has(t.employeeExternalId)) {
        warnings.push({
          severity: 'warn',
          code: 'IMPORT_TIMEOFF_EMPLOYEE_NOT_IN_PAYLOAD',
          message: `TimeOff ${t.externalId} references employee "${t.employeeExternalId}" not in payload`,
          entityRef: { entity: 'timeOff', externalId: t.externalId },
        });
      }
    }
  }

  private checkShiftTimes(
    payload: ImportPayload,
    warnings: ImportWarning[],
  ): void {
    for (const s of payload.data.shifts ?? []) {
      const expectedCrosses = s.endTime <= s.startTime;
      if (expectedCrosses !== s.crossesMidnight) {
        warnings.push({
          severity: 'error',
          code: 'IMPORT_SHIFT_CROSS_MIDNIGHT_MISMATCH',
          message: `Shift ${s.externalId}: crossesMidnight=${s.crossesMidnight} but times suggest ${expectedCrosses}`,
          entityRef: { entity: 'shifts', externalId: s.externalId },
        });
      }
    }
  }

  private checkEmployeeUniqueness(
    payload: ImportPayload,
    warnings: ImportWarning[],
  ): void {
    const emails = new Map<string, string>(); // email → externalId
    const phones = new Map<string, string>();
    for (const e of payload.data.employees ?? []) {
      if (e.email) {
        const k = e.email.toLowerCase();
        const prev = emails.get(k);
        if (prev) {
          warnings.push({
            severity: 'error',
            code: 'IMPORT_EMPLOYEE_EMAIL_DUPLICATE_IN_PAYLOAD',
            message: `Employees ${prev} and ${e.externalId} share email "${e.email}"`,
            entityRef: { entity: 'employees', externalId: e.externalId },
          });
        }
        emails.set(k, e.externalId);
      }
      if (e.phone) {
        const prev = phones.get(e.phone);
        if (prev) {
          warnings.push({
            severity: 'error',
            code: 'IMPORT_EMPLOYEE_PHONE_DUPLICATE_IN_PAYLOAD',
            message: `Employees ${prev} and ${e.externalId} share phone "${e.phone}"`,
            entityRef: { entity: 'employees', externalId: e.externalId },
          });
        }
        phones.set(e.phone, e.externalId);
      }
    }
  }

  private checkTimeOffRanges(
    payload: ImportPayload,
    warnings: ImportWarning[],
  ): void {
    for (const t of payload.data.timeOff ?? []) {
      if (t.startDate > t.endDate) {
        warnings.push({
          severity: 'error',
          code: 'IMPORT_TIMEOFF_INVERTED_RANGE',
          message: `TimeOff ${t.externalId}: startDate ${t.startDate} > endDate ${t.endDate}`,
          entityRef: { entity: 'timeOff', externalId: t.externalId },
        });
      }
    }
  }
}

import { Injectable } from '@nestjs/common';
import type {
  ImportPayload,
  ImportWarning,
} from '../../domain/imports/import-payload.types';
import type { ResolvedReferences } from './import-reference-resolver.service';

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
 *
 * Si se pasa `resolved` (refs externas al payload encontradas en BD),
 * los warnings de tipo `*_NOT_IN_PAYLOAD` se rebajan a severity='info'
 * cuando la ref es resoluble en BD — eso evita el ruido en el caso
 * pyme "subo solo employees con dept apuntando a una BD ya poblada".
 */
@Injectable()
export class ImportValidatorService {
  validate(
    payload: ImportPayload,
    resolved?: ResolvedReferences,
  ): ImportWarning[] {
    const warnings: ImportWarning[] = [];

    this.checkExternalIdUniqueness(payload, warnings);
    this.checkIntraPayloadFks(payload, warnings, resolved);
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
    resolved?: ResolvedReferences,
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

    // Emisor central — si la ref está en `resolved.<entity>`, la BD ya
    // tiene un row matcheable. En ese caso el warning es 'info' (no
    // bloquea ni cuenta como ruido) y el mensaje lo dice explícito.
    const emit = (args: {
      entity: 'shifts' | 'employees' | 'availability' | 'timeOff';
      externalId: string;
      refKind: 'employees' | 'departments' | 'roles' | 'branches';
      refValue: string;
      codeIfPayload: string;
      codeIfDb: string;
      noun: string;
    }) => {
      const inDb = resolved?.[args.refKind].has(args.refValue) ?? false;
      if (inDb) {
        warnings.push({
          severity: 'info',
          code: args.codeIfDb,
          message: `${args.entity.replace(/s$/, '')} ${args.externalId} references ${args.noun} "${args.refValue}" — not in payload, matched in DB`,
          entityRef: { entity: args.entity, externalId: args.externalId },
        });
      } else {
        warnings.push({
          severity: 'warn',
          code: args.codeIfPayload,
          message: `${args.entity.replace(/s$/, '')} ${args.externalId} references ${args.noun} "${args.refValue}" — not in payload and not found in DB`,
          entityRef: { entity: args.entity, externalId: args.externalId },
          suggestion:
            'Include the row in the payload or use a name that matches an existing one in the database.',
        });
      }
    };

    // Shifts → employee / dept / role / location
    for (const s of payload.data.shifts ?? []) {
      if (s.employeeExternalId && !empIds.has(s.employeeExternalId)) {
        emit({
          entity: 'shifts',
          externalId: s.externalId,
          refKind: 'employees',
          refValue: s.employeeExternalId,
          codeIfPayload: 'IMPORT_SHIFT_EMPLOYEE_NOT_IN_PAYLOAD',
          codeIfDb: 'IMPORT_SHIFT_EMPLOYEE_RESOLVED_IN_DB',
          noun: 'employee',
        });
      }
      if (s.requiredRoleExternalId && !roleIds.has(s.requiredRoleExternalId)) {
        emit({
          entity: 'shifts',
          externalId: s.externalId,
          refKind: 'roles',
          refValue: s.requiredRoleExternalId,
          codeIfPayload: 'IMPORT_SHIFT_ROLE_NOT_IN_PAYLOAD',
          codeIfDb: 'IMPORT_SHIFT_ROLE_RESOLVED_IN_DB',
          noun: 'role',
        });
      }
      if (s.departmentExternalId && !deptIds.has(s.departmentExternalId)) {
        emit({
          entity: 'shifts',
          externalId: s.externalId,
          refKind: 'departments',
          refValue: s.departmentExternalId,
          codeIfPayload: 'IMPORT_SHIFT_DEPT_NOT_IN_PAYLOAD',
          codeIfDb: 'IMPORT_SHIFT_DEPT_RESOLVED_IN_DB',
          noun: 'department',
        });
      }
      if (s.locationExternalId && !locIds.has(s.locationExternalId)) {
        emit({
          entity: 'shifts',
          externalId: s.externalId,
          refKind: 'branches',
          refValue: s.locationExternalId,
          codeIfPayload: 'IMPORT_SHIFT_LOCATION_NOT_IN_PAYLOAD',
          codeIfDb: 'IMPORT_SHIFT_LOCATION_RESOLVED_IN_DB',
          noun: 'location',
        });
      }
    }

    // Employees → role(s) y dept
    for (const e of payload.data.employees ?? []) {
      if (e.departmentExternalId && !deptIds.has(e.departmentExternalId)) {
        emit({
          entity: 'employees',
          externalId: e.externalId,
          refKind: 'departments',
          refValue: e.departmentExternalId,
          codeIfPayload: 'IMPORT_EMPLOYEE_DEPT_NOT_IN_PAYLOAD',
          codeIfDb: 'IMPORT_EMPLOYEE_DEPT_RESOLVED_IN_DB',
          noun: 'department',
        });
      }
      for (const rid of e.roleExternalIds ?? []) {
        if (!roleIds.has(rid)) {
          emit({
            entity: 'employees',
            externalId: e.externalId,
            refKind: 'roles',
            refValue: rid,
            codeIfPayload: 'IMPORT_EMPLOYEE_ROLE_NOT_IN_PAYLOAD',
            codeIfDb: 'IMPORT_EMPLOYEE_ROLE_RESOLVED_IN_DB',
            noun: 'role',
          });
        }
      }
    }

    // Availability → employee
    for (const a of payload.data.availability ?? []) {
      if (!empIds.has(a.employeeExternalId)) {
        emit({
          entity: 'availability',
          externalId: a.externalId,
          refKind: 'employees',
          refValue: a.employeeExternalId,
          codeIfPayload: 'IMPORT_AVAILABILITY_EMPLOYEE_NOT_IN_PAYLOAD',
          codeIfDb: 'IMPORT_AVAILABILITY_EMPLOYEE_RESOLVED_IN_DB',
          noun: 'employee',
        });
      }
    }

    // TimeOff → employee
    for (const t of payload.data.timeOff ?? []) {
      if (!empIds.has(t.employeeExternalId)) {
        emit({
          entity: 'timeOff',
          externalId: t.externalId,
          refKind: 'employees',
          refValue: t.employeeExternalId,
          codeIfPayload: 'IMPORT_TIMEOFF_EMPLOYEE_NOT_IN_PAYLOAD',
          codeIfDb: 'IMPORT_TIMEOFF_EMPLOYEE_RESOLVED_IN_DB',
          noun: 'employee',
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

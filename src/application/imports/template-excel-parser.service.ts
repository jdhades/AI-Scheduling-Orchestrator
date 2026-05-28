import { Injectable, Logger } from '@nestjs/common';
import * as XLSX from 'xlsx';
import type {
  ImportPayload,
  ImportSourceMetadata,
} from '../../domain/imports/import-payload.types';
import {
  IMPORT_SCHEMA_VERSION,
} from '../../domain/imports/import-payload.types';
import type { TemplateEntity } from './template-excel-builder.service';
import { TEMPLATE_DEFS } from './template-excel-builder.service';

/**
 * TemplateExcelParser — lee buffers xlsx subidos por el owner, valida
 * headers + tipos + reglas básicas, y devuelve un `ImportPayload` con
 * `source: 'template_excel'` y `confidence: 1.0` (parseo determinístico,
 * cero ambigüedad por construcción).
 *
 * El parser es defensivo: errores fatales (header missing, archivo
 * corrupto) levantan ParseFatalError con detalle por archivo+celda. El
 * controller los serializa a 400 con array para que la UI muestre uno
 * por uno.
 *
 * Errores recuperables (campo opcional malformado) → warning del payload,
 * la fila sigue.
 */

export class ParseFatalError extends Error {
  constructor(
    public readonly errors: ParseError[],
  ) {
    super(`Excel parse failed (${errors.length} errors)`);
    this.name = 'ParseFatalError';
  }
}

export interface ParseError {
  file: string;
  sheet?: string;
  row?: number;
  column?: string;
  code: string;
  message: string;
  value?: string;
}

export interface UploadedFile {
  /** Nombre del archivo subido — usado para identificarlo en errores. */
  originalName: string;
  /** Buffer del .xlsx. */
  buffer: Buffer;
  /** Hint de qué entidad representa, si el owner lo indicó. Si null,
   * el parser detecta por nombre de archivo ("employees.xlsx" → employees). */
  entityHint?: TemplateEntity;
}

const TIME_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class TemplateExcelParserService {
  private readonly logger = new Logger(TemplateExcelParserService.name);

  /**
   * Parsea N archivos xlsx (uno por entidad típicamente) a un único
   * ImportPayload. Si el mismo entity aparece en >1 archivo, las filas
   * se concatenan.
   */
  parse(files: UploadedFile[]): ImportPayload {
    const errors: ParseError[] = [];
    const payload: ImportPayload = {
      schemaVersion: IMPORT_SCHEMA_VERSION,
      source: 'template_excel',
      sourceMetadata: this.metadata(),
      data: {},
    };

    for (const file of files) {
      const entity = file.entityHint ?? this.detectEntity(file.originalName);
      if (!entity) {
        errors.push({
          file: file.originalName,
          code: 'TEMPLATE_UNKNOWN_ENTITY',
          message: `Cannot detect entity from filename. Expected one of: employees, locations, departments, roles, shifts, availability, breaks, time_off`,
        });
        continue;
      }

      try {
        this.parseFile(file, entity, payload, errors);
      } catch (err) {
        errors.push({
          file: file.originalName,
          code: 'TEMPLATE_FILE_CORRUPT',
          message: `Could not read xlsx: ${(err as Error).message}`,
        });
      }
    }

    if (errors.length > 0) {
      throw new ParseFatalError(errors);
    }

    return payload;
  }

  private parseFile(
    file: UploadedFile,
    entity: TemplateEntity,
    payload: ImportPayload,
    errors: ParseError[],
  ): void {
    const wb = XLSX.read(file.buffer, { type: 'buffer' });
    const sheetName = 'data';
    const sheet = wb.Sheets[sheetName];
    if (!sheet) {
      errors.push({
        file: file.originalName,
        code: 'TEMPLATE_SHEET_MISSING',
        message: `Sheet "data" not found. Did you rename the tab?`,
      });
      return;
    }

    const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, {
      defval: '',
      raw: false,
    });
    if (rows.length === 0) {
      // Archivo vacío — no es un error, solo no aporta nada.
      return;
    }

    // Normalizar headers: quitar `*` opcional + trim. El builder emite
    // headers con `*` para indicar required visualmente; el owner los
    // mantiene en el archivo.
    const sample = rows[0];
    const headerMap: Record<string, string> = {};
    for (const rawHeader of Object.keys(sample)) {
      const clean = rawHeader.replace(/\*$/, '').trim();
      headerMap[clean] = rawHeader;
    }

    // Verificar required headers
    const def = TEMPLATE_DEFS[entity];
    for (const col of def.columns) {
      if (col.required && !headerMap[col.key]) {
        errors.push({
          file: file.originalName,
          sheet: sheetName,
          column: col.key,
          code: 'TEMPLATE_HEADER_MISSING',
          message: `Required column "${col.key}" is missing from sheet "data".`,
        });
      }
    }
    if (errors.some((e) => e.file === file.originalName)) {
      return;
    }

    // Construir entities
    const accum: unknown[] = (payload.data as Record<string, unknown[]>)[
      entity === 'time_off' ? 'timeOff' : entity
    ] ??= [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNumber = i + 2; // headers en 1, data desde 2
      const isEmpty = def.columns.every((c) => {
        const v = row[headerMap[c.key]];
        return v === '' || v === undefined || v === null;
      });
      if (isEmpty) continue;

      try {
        const parsed = this.buildEntity(
          entity,
          row,
          headerMap,
          file.originalName,
          rowNumber,
          errors,
        );
        if (parsed) accum.push(parsed);
      } catch (err) {
        errors.push({
          file: file.originalName,
          sheet: sheetName,
          row: rowNumber,
          code: 'TEMPLATE_ROW_INVALID',
          message: (err as Error).message,
        });
      }
    }
  }

  private buildEntity(
    entity: TemplateEntity,
    row: Record<string, unknown>,
    headerMap: Record<string, string>,
    file: string,
    rowNumber: number,
    errors: ParseError[],
  ): unknown | null {
    const get = (key: string): string => {
      const raw = row[headerMap[key]];
      return raw === undefined || raw === null ? '' : String(raw).trim();
    };
    const getNum = (key: string): number | undefined => {
      const s = get(key);
      if (s === '') return undefined;
      const n = Number(s);
      if (Number.isNaN(n)) {
        errors.push({
          file,
          row: rowNumber,
          column: key,
          code: 'TEMPLATE_INVALID_NUMBER',
          message: `Column "${key}" must be a number, got "${s}"`,
          value: s,
        });
        return undefined;
      }
      return n;
    };
    const getBool = (key: string): boolean | undefined => {
      const s = get(key).toLowerCase();
      if (s === '') return undefined;
      if (s === 'true' || s === 'yes' || s === '1') return true;
      if (s === 'false' || s === 'no' || s === '0') return false;
      errors.push({
        file,
        row: rowNumber,
        column: key,
        code: 'TEMPLATE_INVALID_BOOLEAN',
        message: `Column "${key}" must be true/false, got "${s}"`,
        value: s,
      });
      return undefined;
    };
    const requireField = (key: string): string => {
      const v = get(key);
      if (!v) {
        errors.push({
          file,
          row: rowNumber,
          column: key,
          code: 'TEMPLATE_REQUIRED_MISSING',
          message: `Column "${key}" is required and was empty.`,
        });
      }
      return v;
    };
    const requireMatching = (
      key: string,
      pattern: RegExp,
      hint: string,
    ): string => {
      const v = requireField(key);
      if (v && !pattern.test(v)) {
        errors.push({
          file,
          row: rowNumber,
          column: key,
          code: 'TEMPLATE_INVALID_FORMAT',
          message: `Column "${key}" expected ${hint}, got "${v}"`,
          value: v,
        });
      }
      return v;
    };

    switch (entity) {
      case 'employees': {
        return {
          externalId: requireField('external_id'),
          name: requireField('name'),
          email: get('email') || undefined,
          phone: get('phone') || undefined,
          hireDate: get('hire_date') || undefined,
          employmentType: (get('employment_type') as never) || undefined,
          payRate: get('pay_rate_amount')
            ? {
                amount: getNum('pay_rate_amount') ?? 0,
                currency: get('pay_rate_currency') || 'USD',
                period: (get('pay_rate_period') as never) || 'hour',
              }
            : undefined,
          departmentExternalId: get('department_external_id') || undefined,
          roleExternalIds: get('role_external_ids')
            ? get('role_external_ids')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined,
          experienceMonths: getNum('experience_months'),
          confidence: 1,
        };
      }
      case 'locations':
        return {
          externalId: requireField('external_id'),
          name: requireField('name'),
          timezone: get('timezone') || undefined,
          confidence: 1,
        };
      case 'departments':
        return {
          externalId: requireField('external_id'),
          name: requireField('name'),
          locationExternalId: get('location_external_id') || undefined,
          managerEmployeeExternalId:
            get('manager_employee_external_id') || undefined,
          confidence: 1,
        };
      case 'roles':
        return {
          externalId: requireField('external_id'),
          name: requireField('name'),
          confidence: 1,
        };
      case 'shifts': {
        return {
          externalId: requireField('external_id'),
          employeeExternalId: get('employee_external_id') || undefined,
          templateName: get('template_name') || undefined,
          date: requireMatching('date', ISO_DATE, 'YYYY-MM-DD'),
          startTime: requireMatching('start_time', TIME_HHMM, 'HH:mm'),
          endTime: requireMatching('end_time', TIME_HHMM, 'HH:mm'),
          crossesMidnight: getBool('crosses_midnight') ?? false,
          locationExternalId: get('location_external_id') || undefined,
          departmentExternalId: get('department_external_id') || undefined,
          requiredRoleExternalId:
            get('required_role_external_id') || undefined,
          confidence: 1,
        };
      }
      case 'availability':
        return {
          externalId: requireField('external_id'),
          employeeExternalId: requireField('employee_external_id'),
          dayOfWeek: getNum('day_of_week') ?? 0,
          windows: [
            {
              startTime: requireMatching('start_time', TIME_HHMM, 'HH:mm'),
              endTime: requireMatching('end_time', TIME_HHMM, 'HH:mm'),
              available: getBool('available') ?? true,
            },
          ],
          effectiveFrom: get('effective_from') || undefined,
          effectiveUntil: get('effective_until') || undefined,
          confidence: 1,
        };
      case 'breaks':
        return {
          externalId: requireField('external_id'),
          scope: (requireField('scope') as never) || 'policy_global',
          triggerAfterMinutesWorked: getNum('trigger_after_minutes_worked'),
          durationMinutes: getNum('duration_minutes') ?? 0,
          isPaid: getBool('is_paid') ?? false,
          roleExternalId: get('role_external_id') || undefined,
          shiftExternalId: get('shift_external_id') || undefined,
          confidence: 1,
        };
      case 'time_off':
        return {
          externalId: requireField('external_id'),
          employeeExternalId: requireField('employee_external_id'),
          startDate: requireMatching('start_date', ISO_DATE, 'YYYY-MM-DD'),
          endDate: requireMatching('end_date', ISO_DATE, 'YYYY-MM-DD'),
          type: (requireField('type') as never) || 'other',
          reason: get('reason') || undefined,
          status: (requireField('status') as never) || 'approved',
          confidence: 1,
        };
    }
  }

  private detectEntity(filename: string): TemplateEntity | null {
    const lower = filename.toLowerCase();
    if (lower.includes('employee')) return 'employees';
    if (lower.includes('location') || lower.includes('branch'))
      return 'locations';
    if (lower.includes('department')) return 'departments';
    if (lower.includes('role') || lower.includes('skill')) return 'roles';
    if (lower.includes('shift')) return 'shifts';
    if (lower.includes('availability')) return 'availability';
    if (lower.includes('break')) return 'breaks';
    if (lower.includes('time') && lower.includes('off')) return 'time_off';
    if (lower.includes('vacation') || lower.includes('pto')) return 'time_off';
    return null;
  }

  private metadata(): ImportSourceMetadata {
    return {
      extractedAt: new Date().toISOString(),
      agentName: 'template-excel-parser',
      agentVersion: '1.0.0',
      confidence: 1.0,
      notes:
        'Deterministic parse from Excel templates. All rows have confidence=1.',
    };
  }
}

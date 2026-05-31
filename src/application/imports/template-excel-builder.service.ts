import { Injectable } from '@nestjs/common';
import * as XLSX from 'xlsx';

/**
 * TemplateExcelBuilder — genera plantillas xlsx on-demand para cada
 * entidad del schema canónico. Patrón:
 *   - Sheet 1 "data" — headers en fila 1, sample row en fila 2, vacío después.
 *   - Sheet 2 "instructions" — columnas y formato esperados, ejemplos.
 *
 * Server-side para que el formato se pueda cambiar sin redeploy (vs
 * archivos estáticos en disco). Devuelve `Buffer` que el controller
 * sirve con header `Content-Disposition: attachment`.
 */

export type TemplateEntity =
  | 'employees'
  | 'locations'
  | 'departments'
  | 'roles'
  | 'shifts'
  | 'availability'
  | 'breaks'
  | 'time_off';

interface ColumnDef {
  key: string;
  /** Si está en `required` del schema, ponemos asterisco visual. */
  required: boolean;
  /** Formato esperado (texto humano) para sheet de instrucciones. */
  format: string;
  example: string;
}

@Injectable()
export class TemplateExcelBuilderService {
  build(entity: TemplateEntity): Buffer {
    const def = TEMPLATES[entity];
    const wb = XLSX.utils.book_new();

    // Sheet "data"
    const headers = def.columns.map((c) => (c.required ? `${c.key}*` : c.key));
    const sampleRow = def.columns.map((c) => c.example);
    const dataSheet = XLSX.utils.aoa_to_sheet([headers, sampleRow]);

    // Column widths basadas en max(header, example, 12).
    dataSheet['!cols'] = def.columns.map((c, i) => ({
      wch: Math.max(headers[i].length, c.example.length, 12) + 2,
    }));
    XLSX.utils.book_append_sheet(wb, dataSheet, 'data');

    // Sheet "instructions"
    const instructionsRows: Array<Array<string>> = [
      ['Column', 'Required', 'Format', 'Example'],
      ...def.columns.map((c) => [
        c.key,
        c.required ? 'YES' : 'no',
        c.format,
        c.example,
      ]),
      [],
      ['Notes', '', '', ''],
      ...def.notes.map((n) => [n, '', '', '']),
    ];
    const instructionsSheet = XLSX.utils.aoa_to_sheet(instructionsRows);
    instructionsSheet['!cols'] = [
      { wch: 32 },
      { wch: 10 },
      { wch: 40 },
      { wch: 40 },
    ];
    XLSX.utils.book_append_sheet(wb, instructionsSheet, 'instructions');

    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }
}

// ─── Catálogo de plantillas ────────────────────────────────────────────

interface TemplateDef {
  columns: ColumnDef[];
  notes: string[];
}

const COMMON_NOTES = [
  'Headers ending with * are required. Other columns are optional — leave blank if unknown.',
  'Do NOT rename the headers. The parser matches by exact key (case-sensitive).',
  'Empty rows after the data are ignored.',
  'External IDs are free strings (your choice) — they link entities across sheets.',
];

const TEMPLATES: Record<TemplateEntity, TemplateDef> = {
  employees: {
    columns: [
      {
        key: 'external_id',
        required: true,
        format: 'string, unique within this file',
        example: 'emp_001',
      },
      {
        key: 'name',
        required: true,
        format: 'string',
        example: 'María García',
      },
      {
        key: 'email',
        required: false,
        format: 'email (RFC 5322)',
        example: 'maria@example.com',
      },
      {
        key: 'phone',
        required: false,
        format: 'E.164 (+15551234567)',
        // TODO(hardcode): example fijo a +54 (AR) — usable en cualquier
        // región porque el formato E.164 es el mismo; el +54 es solo el
        // país que ve el owner al copiar. Sacarlo cuando exista
        // `companies.country_code` para derivar prefix por tenant.
        example: '+5491134567890',
      },
      {
        key: 'hire_date',
        required: false,
        format: 'YYYY-MM-DD',
        example: '2024-03-15',
      },
      {
        key: 'employment_type',
        required: false,
        format: 'full_time | part_time | contractor | intern',
        example: 'full_time',
      },
      {
        key: 'pay_rate_amount',
        required: false,
        format: 'number',
        example: '15.50',
      },
      {
        key: 'pay_rate_currency',
        required: false,
        format: 'ISO 4217 (USD, ARS, EUR…)',
        example: 'USD',
      },
      {
        key: 'pay_rate_period',
        required: false,
        format: 'hour | week | month',
        example: 'hour',
      },
      {
        key: 'department_external_id',
        required: false,
        format: 'must match an external_id in departments.xlsx',
        example: 'dept_kitchen',
      },
      {
        key: 'role_external_ids',
        required: false,
        format: 'comma-separated external_ids from roles.xlsx',
        example: 'role_cashier,role_server',
      },
      {
        key: 'experience_months',
        required: false,
        format: 'integer ≥ 0',
        example: '24',
      },
    ],
    notes: [...COMMON_NOTES],
  },
  locations: {
    columns: [
      {
        key: 'external_id',
        required: true,
        format: 'string, unique',
        example: 'loc_main',
      },
      {
        key: 'name',
        required: true,
        format: 'string',
        example: 'Main Branch',
      },
      {
        key: 'timezone',
        required: false,
        format: 'IANA (America/Argentina/Buenos_Aires)',
        example: 'America/Argentina/Buenos_Aires',
      },
    ],
    notes: [...COMMON_NOTES],
  },
  departments: {
    columns: [
      {
        key: 'external_id',
        required: true,
        format: 'string, unique',
        example: 'dept_kitchen',
      },
      {
        key: 'name',
        required: true,
        format: 'string',
        example: 'Kitchen',
      },
      {
        key: 'location_external_id',
        required: false,
        format: 'must match an external_id in locations.xlsx',
        example: 'loc_main',
      },
      {
        key: 'manager_employee_external_id',
        required: false,
        format: 'must match an external_id in employees.xlsx',
        example: 'emp_001',
      },
    ],
    notes: [...COMMON_NOTES],
  },
  roles: {
    columns: [
      {
        key: 'external_id',
        required: true,
        format: 'string, unique',
        example: 'role_cashier',
      },
      {
        key: 'name',
        required: true,
        format: 'string (becomes a company skill)',
        example: 'Cashier',
      },
    ],
    notes: [
      ...COMMON_NOTES,
      'Roles are persisted as company_skills internally (skill catalog reused across tenants).',
    ],
  },
  shifts: {
    columns: [
      {
        key: 'external_id',
        required: true,
        format: 'string, unique',
        example: 'shift_001',
      },
      {
        key: 'employee_external_id',
        required: false,
        format: 'leave blank for "open shift"',
        example: 'emp_001',
      },
      {
        key: 'template_name',
        required: false,
        format: 'name of a shift template (if any)',
        example: 'Morning Shift',
      },
      {
        key: 'date',
        required: true,
        format: 'YYYY-MM-DD',
        example: '2026-06-01',
      },
      {
        key: 'start_time',
        required: true,
        format: 'HH:mm (24h, wall-clock)',
        example: '08:00',
      },
      {
        key: 'end_time',
        required: true,
        format: 'HH:mm',
        example: '16:00',
      },
      {
        key: 'crosses_midnight',
        required: true,
        format: 'true | false',
        example: 'false',
      },
      {
        key: 'location_external_id',
        required: false,
        format: '',
        example: 'loc_main',
      },
      {
        key: 'department_external_id',
        required: false,
        format: '',
        example: 'dept_kitchen',
      },
      {
        key: 'required_role_external_id',
        required: false,
        format: 'role required for this shift',
        example: 'role_cashier',
      },
    ],
    notes: [
      ...COMMON_NOTES,
      'If end_time ≤ start_time, set crosses_midnight=true (the shift ends the next day).',
    ],
  },
  availability: {
    columns: [
      {
        key: 'external_id',
        required: true,
        format: 'string, unique',
        example: 'avail_001',
      },
      {
        key: 'employee_external_id',
        required: true,
        format: 'must match an employee external_id',
        example: 'emp_001',
      },
      {
        key: 'day_of_week',
        required: true,
        format: '0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat',
        example: '1',
      },
      {
        key: 'start_time',
        required: true,
        format: 'HH:mm',
        example: '09:00',
      },
      {
        key: 'end_time',
        required: true,
        format: 'HH:mm',
        example: '17:00',
      },
      {
        key: 'available',
        required: true,
        format: 'true | false',
        example: 'true',
      },
      {
        key: 'effective_from',
        required: false,
        format: 'YYYY-MM-DD',
        example: '2026-01-01',
      },
      {
        key: 'effective_until',
        required: false,
        format: 'YYYY-MM-DD',
        example: '2026-12-31',
      },
    ],
    notes: [...COMMON_NOTES],
  },
  breaks: {
    columns: [
      {
        key: 'external_id',
        required: true,
        format: 'string, unique',
        example: 'break_001',
      },
      {
        key: 'scope',
        required: true,
        format: 'policy_global | policy_role | shift_specific',
        example: 'policy_global',
      },
      {
        key: 'trigger_after_minutes_worked',
        required: false,
        format: 'integer; break activates after N min worked',
        example: '240',
      },
      {
        key: 'duration_minutes',
        required: true,
        format: 'integer ≥ 1',
        example: '30',
      },
      {
        key: 'is_paid',
        required: true,
        format: 'true | false',
        example: 'false',
      },
      {
        key: 'role_external_id',
        required: false,
        format: 'required if scope=policy_role',
        example: 'role_cashier',
      },
      {
        key: 'shift_external_id',
        required: false,
        format: 'required if scope=shift_specific',
        example: 'shift_001',
      },
    ],
    notes: [...COMMON_NOTES],
  },
  time_off: {
    columns: [
      {
        key: 'external_id',
        required: true,
        format: 'string, unique',
        example: 'to_001',
      },
      {
        key: 'employee_external_id',
        required: true,
        format: 'must match an employee external_id',
        example: 'emp_001',
      },
      {
        key: 'start_date',
        required: true,
        format: 'YYYY-MM-DD',
        example: '2026-07-10',
      },
      {
        key: 'end_date',
        required: true,
        format: 'YYYY-MM-DD',
        example: '2026-07-20',
      },
      {
        key: 'type',
        required: true,
        format: 'vacation | sick | personal | unpaid | other',
        example: 'vacation',
      },
      {
        key: 'reason',
        required: false,
        format: 'free text ≤ 500 chars',
        example: 'Summer holidays',
      },
      {
        key: 'status',
        required: true,
        format: 'approved | pending | rejected',
        example: 'approved',
      },
    ],
    notes: [...COMMON_NOTES],
  },
};

export const TEMPLATE_DEFS = TEMPLATES;

import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  EMPLOYEE_REPOSITORY,
  type IEmployeeRepository,
} from '../../domain/repositories/employee.repository';
import {
  WorkingTimePolicyResolver,
  // no default export — imported via type above
} from '../../domain/services/working-time-policy.resolver';
import type { WorkingTimePolicyOverrides } from '../../domain/value-objects/working-time-policy.vo';

type PolicySource = 'employee' | 'department' | 'company' | 'system-fallback';

/**
 * WorkingTimePolicyController
 *
 * GET /employees/:id/working-time-policy
 *
 * Devuelve la política de tiempo efectiva para un empleado, resuelta por
 * el mismo resolver que usa el handler de generación. Incluye también los
 * overrides puros por nivel y la "source" (de dónde viene cada cap) para
 * que la UI pueda mostrar la jerarquía.
 *
 * NOTA: el PATCH de los overrides por empleado ya está cubierto en
 * `PATCH /employees/:id` (campos maxHoursPerDay / maxHoursPerWeek).
 * Los overrides por department y company los gestiona otro rol (fuera
 * del alcance del dashboard del manager).
 */
@Controller('employees')
export class WorkingTimePolicyController {
  constructor(
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepo: IEmployeeRepository,
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
  ) {}

  @Get(':id/working-time-policy')
  async getPolicy(
    @Param('id') employeeId: string,
    @CurrentCompany() companyId: string,
  ): Promise<object> {
    const employee = await this.employeeRepo.findById(employeeId, companyId);
    if (!employee) {
      throw new NotFoundException(`Employee ${employeeId} not found`);
    }

    const [companyRes, deptRes] = await Promise.all([
      this.supabase
        .from('companies')
        .select('default_max_hours_per_day, default_max_hours_per_week')
        .eq('id', companyId)
        .maybeSingle(),
      employee.departmentId
        ? this.supabase
            .from('departments')
            .select('max_hours_per_day, max_hours_per_week')
            .eq('id', employee.departmentId)
            .eq('company_id', companyId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const toNum = (v: unknown): number | null =>
      v == null ? null : Number(v);

    const companyOverrides: WorkingTimePolicyOverrides = {
      maxHoursPerDay: toNum(companyRes.data?.default_max_hours_per_day),
      maxHoursPerWeek: toNum(companyRes.data?.default_max_hours_per_week),
    };
    const departmentOverrides: WorkingTimePolicyOverrides | null = deptRes.data
      ? {
          maxHoursPerDay: toNum(deptRes.data.max_hours_per_day),
          maxHoursPerWeek: toNum(deptRes.data.max_hours_per_week),
        }
      : null;
    const employeeOverrides: WorkingTimePolicyOverrides = {
      maxHoursPerDay: employee.workingTimeOverrides?.maxHoursPerDay ?? null,
      maxHoursPerWeek: employee.workingTimeOverrides?.maxHoursPerWeek ?? null,
    };

    const effective = WorkingTimePolicyResolver.resolve({
      employee: employeeOverrides,
      department: departmentOverrides,
      company: companyOverrides,
    });

    const source = (key: 'maxHoursPerDay' | 'maxHoursPerWeek'): PolicySource => {
      if (employeeOverrides[key] != null) return 'employee';
      if (departmentOverrides?.[key] != null) return 'department';
      if (companyOverrides[key] != null) return 'company';
      return 'system-fallback';
    };

    return {
      employeeId,
      companyId,
      departmentId: employee.departmentId ?? null,
      effective: {
        maxHoursPerDay: effective.maxHoursPerDay,
        maxHoursPerWeek: effective.maxHoursPerWeek,
      },
      source: {
        maxHoursPerDay: source('maxHoursPerDay'),
        maxHoursPerWeek: source('maxHoursPerWeek'),
      },
      overrides: {
        employee: employeeOverrides,
        department: departmentOverrides,
        company: companyOverrides,
      },
    };
  }
}

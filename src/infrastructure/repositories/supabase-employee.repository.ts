import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import { Employee } from '../../domain/aggregates/employee.aggregate';
import { PhoneNumber } from '../../domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../domain/value-objects/experience-level.vo';
import { EmployeeAvailability } from '../../domain/value-objects/employee-availability.vo';
import {
  EmployeePreference,
  PreferenceType,
} from '../../domain/value-objects/employee-preference.vo';
import { TenantContext } from '../tenant/tenant.context';

const DEFAULT_EXPERIENCE_RANGES = { junior: 6, intermediate: 24, senior: 999 };

@Injectable()
export class SupabaseEmployeeRepository implements IEmployeeRepository {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    private readonly tenantContext: TenantContext,
  ) {}

  async save(employee: Employee): Promise<void> {
    const { error } = await this.supabase.from('employees').upsert({
      id: employee.id,
      company_id: employee.companyId,
      name: employee.name,
      role: employee.role,
      phone_number: employee.phone,
      experience_months: employee.experienceMonths,
      locale: employee.locale,
      hire_date: new Date().toISOString().split('T')[0],
    });

    if (error)
      throw new Error(`EmployeeRepository.save failed: ${error.message}`);
  }

  async findById(id: string, companyId: string): Promise<Employee | null> {
    const { data, error } = await this.supabase
      .from('employees')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single();

    if (error || !data) return null;
    return this.toDomain(data);
  }

  async findByPhone(
    phone: string,
    companyId: string,
  ): Promise<Employee | null> {
    let query = this.supabase
      .from('employees')
      .select('*')
      .eq('phone_number', phone);

    // Wildcard '*' = search across all companies (used by WhatsApp webhook)
    if (companyId !== '*') {
      query = query.eq('company_id', companyId);
    }

    const { data, error } = await query.single();

    if (error || !data) return null;
    return this.toDomain(data);
  }

  async findAllByCompany(companyId: string, options?: { departmentId?: string; branchId?: string }): Promise<Employee[]> {
    let query = this.supabase
      .from('employees')
      .select(
        `
                *,
                employee_skills (
                    company_skill_id,
                    level
                ),
                employee_availability (
                    id,
                    day_of_week,
                    start_time,
                    end_time
                ),
                employee_preferences (
                    id,
                    preference_type,
                    weight
                )
            `,
      )
      .eq('company_id', companyId);

    if (options?.departmentId) {
      query = query.eq('department_id', options.departmentId);
    }

    const { data, error } = await query;

    if (error)
      throw new Error(
        `EmployeeRepository.findAllByCompany failed: ${error.message}`,
      );
    return (data ?? []).map((row) => this.toDomain(row));
  }

  async markWhatsappVerified(employeeId: string): Promise<void> {
    const companyId = this.tenantContext.get();
    const { error } = await this.supabase
      .from('employees')
      .update({ whatsapp_verified: true })
      .eq('id', employeeId)
      .eq('company_id', companyId);

    if (error)
      throw new Error(
        `EmployeeRepository.markVerified failed: ${error.message}`,
      );
  }

  private toDomain(row: Record<string, any>): Employee {
    // Map availability rows → EmployeeAvailability VOs
    const availability: EmployeeAvailability[] = (
      row.employee_availability ?? []
    ).map(
      (a: any) =>
        new EmployeeAvailability(a.id, a.day_of_week, a.start_time, a.end_time),
    );

    // Map preference rows → EmployeePreference VOs
    const preferences: EmployeePreference[] = (
      row.employee_preferences ?? []
    ).map(
      (p: any) =>
        new EmployeePreference(
          p.id,
          p.preference_type as PreferenceType,
          p.weight,
        ),
    );

    const employee = Employee.fromPersistence({
      id: row.id,
      companyId: row.company_id,
      name: row.name,
      role: row.role || 'employee',
      phoneNumber: PhoneNumber.create(row.phone_number),
      experience: new ExperienceLevel(
        row.experience_months,
        DEFAULT_EXPERIENCE_RANGES,
      ),
      locale: row.locale,
      availability,
      preferences,
      departmentId: row.department_id,
      contractType: row.contract_type ?? undefined,
      workingTimeOverrides: {
        maxHoursPerDay: row.max_hours_per_day != null ? Number(row.max_hours_per_day) : null,
        maxHoursPerWeek: row.max_hours_per_week != null ? Number(row.max_hours_per_week) : null,
      },
    });

    // Hydrate skills
    if (row.employee_skills && Array.isArray(row.employee_skills)) {
      for (const es of row.employee_skills) {
        employee.assignSkill(
          {
            id: es.company_skill_id,
            companyId: row.company_id,
            globalSkillId: 'any',
            equals: (other: any) => other.id === es.company_skill_id,
          } as any,
          { validateEmployee: () => true } as any,
        );
      }
    }

    return employee;
  }
}

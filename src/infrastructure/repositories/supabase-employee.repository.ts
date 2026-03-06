import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import { Employee } from '../../domain/aggregates/employee.aggregate';
import { PhoneNumber } from '../../domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../domain/value-objects/experience-level.vo';
import { TenantContext } from '../tenant/tenant.context';

/**
 * SupabaseEmployeeRepository — Adapter (DDD)
 *
 * Implementación concreta del IEmployeeRepository usando Supabase JS.
 * El domain layer no sabe que este archivo existe.
 *
 * Convenciones:
 *  - Siempre filtra por company_id (multi-tenant)
 *  - TenantContext inyectado para obtener el tenant actual
 *  - fromPersistence() reconstruye el aggregate sin disparar eventos
 *
 * Rangos de ExperienceLevel por defecto (pueden configurarse por empresa en el futuro):
 */
const DEFAULT_EXPERIENCE_RANGES = { junior: 6, intermediate: 24, senior: 999 };

@Injectable()
export class SupabaseEmployeeRepository implements IEmployeeRepository {
    constructor(
        @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
        private readonly tenantContext: TenantContext,
    ) { }

    async save(employee: Employee): Promise<void> {
        const { error } = await this.supabase
            .from('employees')
            .upsert({
                id: employee.id,
                company_id: employee.companyId,
                name: 'pending',          // TODO: add name field to Employee aggregate
                phone_number: employee.phone,
                experience_months: employee.experienceMonths,
                hire_date: new Date().toISOString().split('T')[0],
            });

        if (error) throw new Error(`EmployeeRepository.save failed: ${error.message}`);
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

    async findByPhone(phone: string, companyId: string): Promise<Employee | null> {
        const { data, error } = await this.supabase
            .from('employees')
            .select('*')
            .eq('phone_number', phone)
            .eq('company_id', companyId)
            .single();

        if (error || !data) return null;
        return this.toDomain(data);
    }

    async findAllByCompany(companyId: string): Promise<Employee[]> {
        const { data, error } = await this.supabase
            .from('employees')
            .select('*')
            .eq('company_id', companyId);

        if (error) throw new Error(`EmployeeRepository.findAllByCompany failed: ${error.message}`);
        return (data ?? []).map(row => this.toDomain(row));
    }

    async markWhatsappVerified(employeeId: string): Promise<void> {
        const companyId = this.tenantContext.get();
        const { error } = await this.supabase
            .from('employees')
            .update({ whatsapp_verified: true })
            .eq('id', employeeId)
            .eq('company_id', companyId);

        if (error) throw new Error(`EmployeeRepository.markVerified failed: ${error.message}`);
    }

    private toDomain(row: Record<string, any>): Employee {
        return Employee.fromPersistence({
            id: row.id,
            companyId: row.company_id,
            phoneNumber: PhoneNumber.create(row.phone_number),
            experience: new ExperienceLevel(row.experience_months, DEFAULT_EXPERIENCE_RANGES),
        });
    }
}

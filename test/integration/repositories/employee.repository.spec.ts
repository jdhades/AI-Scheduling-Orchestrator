import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { PhoneNumber } from '../../../src/domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../../src/domain/value-objects/experience-level.vo';
import { Employee } from '../../../src/domain/aggregates/employee.aggregate';
import { TenantContext } from '../../../src/infrastructure/tenant/tenant.context';
import { SupabaseEmployeeRepository } from '../../../src/infrastructure/repositories/supabase-employee.repository';

/**
 * 🧪 INTEGRATION TEST: SupabaseEmployeeRepository
 *
 * ⚠️  Requires: supabase start + migration applied
 *
 * UUIDs fijos para test company/employees para facilitar cleanup.
 * companies schema: id, name, allow_employee_swap, auto_notification, created_at
 * (NO timezone column)
 */

const DEFAULT_RANGES = { junior: 6, intermediate: 24, senior: 999 };

// Fixed test UUIDs (válidos pero ficticios)
const TEST_COMPANY_ID = '00000000-0000-4000-8000-000000000001';
const TEST_EMPLOYEE_ID_1 = '11111111-0000-4000-8000-000000000001';
const TEST_EMPLOYEE_ID_2 = '11111111-0000-4000-8000-000000000002';

describe('SupabaseEmployeeRepository (integration)', () => {
    let supabase: SupabaseClient;
    let tenantContext: TenantContext;
    let repo: SupabaseEmployeeRepository;

    beforeAll(async () => {
        const url = process.env.SUPABASE_URL;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !serviceKey) {
            throw new Error(
                'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. ' +
                'Run: supabase start',
            );
        }

        supabase = createClient(url, serviceKey, {
            auth: { persistSession: false, autoRefreshToken: false },
        });

        // Crear empresa de test — schema real: id, name, allow_employee_swap, auto_notification
        await supabase.from('companies').upsert({
            id: TEST_COMPANY_ID,
            name: 'Integration Test Company',
            allow_employee_swap: false,
            auto_notification: false,
        });

        tenantContext = new TenantContext();
        tenantContext.set(TEST_COMPANY_ID);
        repo = new SupabaseEmployeeRepository(supabase, tenantContext);
    });

    afterAll(async () => {
        await supabase.from('employees').delete().eq('company_id', TEST_COMPANY_ID);
        await supabase.from('companies').delete().eq('id', TEST_COMPANY_ID);
    });

    afterEach(async () => {
        await supabase
            .from('employees')
            .delete()
            .in('id', [TEST_EMPLOYEE_ID_1, TEST_EMPLOYEE_ID_2]);
    });

    // ─── save ─────────────────────────────────────────────────────────────────

    describe('save()', () => {
        it('should persist a new employee to the database', async () => {
            const phone = PhoneNumber.create('+12025550101');
            const experience = new ExperienceLevel(12, DEFAULT_RANGES);
            const employee = Employee.fromPersistence({
                id: TEST_EMPLOYEE_ID_1,
                companyId: TEST_COMPANY_ID,
                phoneNumber: phone,
                experience,
            });

            await repo.save(employee);

            const { data } = await supabase
                .from('employees')
                .select('id, company_id')
                .eq('id', TEST_EMPLOYEE_ID_1)
                .single();

            expect(data).not.toBeNull();
            expect(data!.id).toBe(TEST_EMPLOYEE_ID_1);
            expect(data!.company_id).toBe(TEST_COMPANY_ID);
        });

        it('should upsert without error when saving the same employee twice', async () => {
            const phone = PhoneNumber.create('+12025550102');
            const experience = new ExperienceLevel(24, DEFAULT_RANGES);
            const employee = Employee.fromPersistence({
                id: TEST_EMPLOYEE_ID_1,
                companyId: TEST_COMPANY_ID,
                phoneNumber: phone,
                experience,
            });

            await expect(repo.save(employee)).resolves.not.toThrow();
            await expect(repo.save(employee)).resolves.not.toThrow();
        });
    });

    // ─── findById ─────────────────────────────────────────────────────────────

    describe('findById()', () => {
        it('should return null when employee does not exist', async () => {
            const result = await repo.findById(
                '99999999-0000-4000-8000-000000000001',
                TEST_COMPANY_ID,
            );
            expect(result).toBeNull();
        });

        it('should reconstruct the Employee aggregate from the database', async () => {
            await supabase.from('employees').insert({
                id: TEST_EMPLOYEE_ID_1,
                company_id: TEST_COMPANY_ID,
                name: 'Test Employee',
                phone_number: '+12025550103',
                hire_date: '2023-01-01',
                experience_months: 18,
            });

            const employee = await repo.findById(TEST_EMPLOYEE_ID_1, TEST_COMPANY_ID);

            expect(employee).not.toBeNull();
            expect(employee!.id).toBe(TEST_EMPLOYEE_ID_1);
            expect(employee!.companyId).toBe(TEST_COMPANY_ID);
        });

        it('should not return employee from a different company (tenant isolation)', async () => {
            await supabase.from('employees').insert({
                id: TEST_EMPLOYEE_ID_1,
                company_id: TEST_COMPANY_ID,
                name: 'Test Employee',
                phone_number: '+12025550104',
                hire_date: '2023-01-01',
                experience_months: 6,
            });

            const result = await repo.findById(
                TEST_EMPLOYEE_ID_1,
                '99999999-0000-4000-8000-000000000099', // different company
            );
            expect(result).toBeNull();
        });
    });

    // ─── findByPhone ──────────────────────────────────────────────────────────

    describe('findByPhone()', () => {
        it('should find an employee by phone number', async () => {
            const targetPhone = '+12025550105';
            await supabase.from('employees').insert({
                id: TEST_EMPLOYEE_ID_1,
                company_id: TEST_COMPANY_ID,
                name: 'Phone Test Employee',
                phone_number: targetPhone,
                hire_date: '2023-01-01',
                experience_months: 6,
            });

            const employee = await repo.findByPhone(targetPhone, TEST_COMPANY_ID);

            expect(employee).not.toBeNull();
            expect(employee!.id).toBe(TEST_EMPLOYEE_ID_1);
        });

        it('should return null for phone not in this tenant', async () => {
            const result = await repo.findByPhone('+19999999999', TEST_COMPANY_ID);
            expect(result).toBeNull();
        });
    });

    // ─── markWhatsappVerified ─────────────────────────────────────────────────

    describe('markWhatsappVerified()', () => {
        it('should set whatsapp_verified = true for the employee', async () => {
            await supabase.from('employees').insert({
                id: TEST_EMPLOYEE_ID_1,
                company_id: TEST_COMPANY_ID,
                name: 'Verify Test Employee',
                phone_number: '+12025550106',
                hire_date: '2023-01-01',
                experience_months: 6,
                whatsapp_verified: false,
            });

            await repo.markWhatsappVerified(TEST_EMPLOYEE_ID_1);

            const { data } = await supabase
                .from('employees')
                .select('whatsapp_verified')
                .eq('id', TEST_EMPLOYEE_ID_1)
                .single();

            expect(data?.whatsapp_verified).toBe(true);
        });
    });
});

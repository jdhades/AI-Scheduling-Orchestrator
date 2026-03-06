import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { AppModule } from './../src/app.module';

/**
 * 🧪 E2E TEST: EmployeeController
 *
 * Levanta la aplicación NestJS completa contra Supabase local.
 * Ejerce los endpoints HTTP reales:
 *   POST /employees        → RegisterEmployeeCommand → DB
 *   GET  /employees/:id/calendar → GetEmployeeCalendarQuery → []
 *
 * ✅ Cada test usa UUIDs únicos para evitar colisiones.
 * ✅ afterAll limpia la DB y cierra la app.
 * ⚠️  Requires: supabase start (local instance en 127.0.0.1:54321)
 */

const TEST_COMPANY_ID = '00000000-0000-4000-8000-000000000010';
const TEST_EMPLOYEE_ID = 'eeeeeeee-0000-4000-8000-000000000010';

describe('EmployeeController (e2e)', () => {
    let app: INestApplication<App>;
    let supabase: SupabaseClient;

    beforeAll(async () => {
        const url = process.env.SUPABASE_URL!;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
        supabase = createClient(url, key, {
            auth: { persistSession: false, autoRefreshToken: false },
        });

        await supabase.from('companies').upsert({
            id: TEST_COMPANY_ID,
            name: 'E2E Test Company (Employee)',
            allow_employee_swap: false,
            auto_notification: false,
        });

        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
        }));
        await app.init();
    });

    afterAll(async () => {
        await supabase.from('employees').delete().eq('company_id', TEST_COMPANY_ID);
        await supabase.from('companies').delete().eq('id', TEST_COMPANY_ID);
        await app.close();
    });

    afterEach(async () => {
        await supabase.from('employees').delete().eq('id', TEST_EMPLOYEE_ID);
    });

    // ─── POST /employees ──────────────────────────────────────────────────────

    describe('POST /employees', () => {
        it('should register a new employee and return 201 with employeeId', () => {
            return request(app.getHttpServer())
                .post('/employees')
                .set('X-Company-Id', TEST_COMPANY_ID)
                .send({
                    employeeId: TEST_EMPLOYEE_ID,
                    phone: '+12025550110',
                    experienceMonths: 12,
                })
                .expect(201)
                .expect((res) => {
                    expect(res.body.employeeId).toBe(TEST_EMPLOYEE_ID);
                });
        });

        it('should return 400 when phone is missing', () => {
            return request(app.getHttpServer())
                .post('/employees')
                .set('X-Company-Id', TEST_COMPANY_ID)
                .send({ employeeId: TEST_EMPLOYEE_ID, experienceMonths: 12 })
                .expect(400);
        });

        it('should return 400 when experienceMonths is negative', () => {
            return request(app.getHttpServer())
                .post('/employees')
                .set('X-Company-Id', TEST_COMPANY_ID)
                .send({ employeeId: TEST_EMPLOYEE_ID, phone: '+12025550111', experienceMonths: -5 })
                .expect(400);
        });

        it('should return 400 when body has unknown extra fields (whitelist)', () => {
            return request(app.getHttpServer())
                .post('/employees')
                .set('X-Company-Id', TEST_COMPANY_ID)
                .send({
                    employeeId: TEST_EMPLOYEE_ID,
                    phone: '+12025550112',
                    experienceMonths: 0,
                    hackerField: 'injected',
                })
                .expect(400);
        });
    });

    // ─── GET /employees/:id/calendar ──────────────────────────────────────────

    describe('GET /employees/:id/calendar', () => {
        it('should return 200 with an array of shifts (empty for now)', () => {
            return request(app.getHttpServer())
                .get(`/employees/${TEST_EMPLOYEE_ID}/calendar`)
                .set('X-Company-Id', TEST_COMPANY_ID)
                .query({ from: '2025-01-01', to: '2025-01-31' })
                .expect(200)
                .expect((res) => {
                    expect(Array.isArray(res.body)).toBe(true);
                });
        });

        it('should return 200 even when employee does not exist (query stub returns [])', () => {
            return request(app.getHttpServer())
                .get('/employees/99999999-0000-4000-8000-000000000001/calendar')
                .set('X-Company-Id', TEST_COMPANY_ID)
                .query({ from: '2025-01-01', to: '2025-01-31' })
                .expect(200)
                .expect((res) => {
                    expect(Array.isArray(res.body)).toBe(true);
                });
        });
    });
});

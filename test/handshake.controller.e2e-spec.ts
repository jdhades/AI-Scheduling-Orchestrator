import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { AppModule } from './../src/app.module';

/**
 * 🧪 E2E TEST: HandshakeController
 *
 * Ejerce el flujo completo de vinculación WhatsApp:
 *   POST /employees/:id/handshake  → initiate (202)
 *   POST /employees/:id/verify     → verify token (200 | 4xx)
 *
 * ⚠️  Requires: supabase start (local instance en 127.0.0.1:54321)
 */

const TEST_COMPANY_ID = '00000000-0000-4000-8000-000000000020';
const TEST_EMPLOYEE_ID = 'eeeeeeee-0000-4000-8000-000000000020';
const VALID_HANDSHAKE_ID = 'cccccccc-0000-4000-8000-000000000020';

describe('HandshakeController (e2e)', () => {
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
      name: 'E2E Test Company (Handshake)',
      allow_employee_swap: false,
      auto_notification: false,
    });
    await supabase.from('employees').upsert({
      id: TEST_EMPLOYEE_ID,
      company_id: TEST_COMPANY_ID,
      name: 'E2E Handshake Employee',
      phone_number: '+12025550120',
      hire_date: '2023-01-01',
      experience_months: 12,
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await supabase
      .from('whatsapp_handshakes')
      .delete()
      .eq('employee_id', TEST_EMPLOYEE_ID);
    await supabase.from('employees').delete().eq('id', TEST_EMPLOYEE_ID);
    await supabase.from('companies').delete().eq('id', TEST_COMPANY_ID);
    await app.close();
  });

  afterEach(async () => {
    await supabase
      .from('whatsapp_handshakes')
      .delete()
      .eq('employee_id', TEST_EMPLOYEE_ID);
  });

  // ─── POST /employees/:id/handshake ────────────────────────────────────────

  describe('POST /employees/:id/handshake', () => {
    it('should initiate handshake and return 202 with message', () => {
      return request(app.getHttpServer())
        .post(`/employees/${TEST_EMPLOYEE_ID}/handshake`)
        .set('X-Company-Id', TEST_COMPANY_ID)
        .send({ handshakeId: VALID_HANDSHAKE_ID, phone: '+12025550120' })
        .expect(202)
        .expect((res) => {
          expect(res.body.message).toBeDefined();
          expect(res.body.message).toContain('initiated');
        });
    });

    it('should persist the handshake in DB after initiate', async () => {
      await request(app.getHttpServer())
        .post(`/employees/${TEST_EMPLOYEE_ID}/handshake`)
        .set('X-Company-Id', TEST_COMPANY_ID)
        .send({ handshakeId: VALID_HANDSHAKE_ID, phone: '+12025550120' })
        .expect(202);

      const { data } = await supabase
        .from('whatsapp_handshakes')
        .select('id, verified')
        .eq('id', VALID_HANDSHAKE_ID)
        .single();

      expect(data).not.toBeNull();
      expect(data!.verified).toBe(false);
    });

    it('should return 400 when handshakeId is not a valid UUID v4', () => {
      return request(app.getHttpServer())
        .post(`/employees/${TEST_EMPLOYEE_ID}/handshake`)
        .set('X-Company-Id', TEST_COMPANY_ID)
        .send({ handshakeId: 'not-a-uuid', phone: '+12025550120' })
        .expect(400);
    });

    it('should return 400 when phone is missing', () => {
      return request(app.getHttpServer())
        .post(`/employees/${TEST_EMPLOYEE_ID}/handshake`)
        .set('X-Company-Id', TEST_COMPANY_ID)
        .send({ handshakeId: VALID_HANDSHAKE_ID })
        .expect(400);
    });
  });

  // ─── POST /employees/:id/verify ───────────────────────────────────────────

  describe('POST /employees/:id/verify', () => {
    it('should return 404 when handshake does not exist', () => {
      return request(app.getHttpServer())
        .post(`/employees/${TEST_EMPLOYEE_ID}/verify`)
        .set('X-Company-Id', TEST_COMPANY_ID)
        .send({ token: VALID_HANDSHAKE_ID })
        .expect(404);
    });

    it('should verify successfully with correct token and return 200', async () => {
      // Insertar handshake directamente — usar employeeId como handshakeId
      // (el controller usa el :id del path como handshakeId en VerifyHandshakeCommand)
      const expiresAt = new Date(Date.now() + 15 * 60_000);
      await supabase.from('whatsapp_handshakes').insert({
        id: TEST_EMPLOYEE_ID, // handshakeId = employeeId en el controller
        employee_id: TEST_EMPLOYEE_ID,
        token: VALID_HANDSHAKE_ID, // el token que envía el cliente
        expires_at: expiresAt.toISOString(),
        verified: false,
      });

      return request(app.getHttpServer())
        .post(`/employees/${TEST_EMPLOYEE_ID}/verify`)
        .set('X-Company-Id', TEST_COMPANY_ID)
        .send({ token: VALID_HANDSHAKE_ID })
        .expect(200)
        .expect((res) => {
          expect(res.body.message).toContain('verified');
        });
    });

    it('should return 400 when token is not a valid UUID', () => {
      return request(app.getHttpServer())
        .post(`/employees/${TEST_EMPLOYEE_ID}/verify`)
        .set('X-Company-Id', TEST_COMPANY_ID)
        .send({ token: 'bad-token' })
        .expect(400);
    });
  });
});

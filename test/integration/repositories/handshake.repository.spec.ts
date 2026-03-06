import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { HandshakeToken } from '../../../src/domain/value-objects/handshake-token.vo';
import { WhatsappHandshake } from '../../../src/domain/aggregates/whatsapp-handshake.aggregate';
import { SupabaseHandshakeRepository } from '../../../src/infrastructure/repositories/supabase-handshake.repository';

/**
 * 🧪 INTEGRATION TEST: SupabaseHandshakeRepository
 *
 * ⚠️  Requires: supabase start + migration applied
 *
 * IMPORTANT: whatsapp_handshakes.token es tipo UUID en la DB.
 * Los UUIDs deben ser válidos: versión nibble = '4', variant nibble = '8'|'9'|'a'|'b'
 */

// UUID v4 válidos para test
const TEST_COMPANY_ID = '00000000-0000-4000-8000-000000000001';
const TEST_EMPLOYEE_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const TEST_HANDSHAKE_ID_1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const TEST_HANDSHAKE_ID_2 = 'bbbbbbbb-0000-4000-8000-000000000002';

describe('SupabaseHandshakeRepository (integration)', () => {
    let supabase: SupabaseClient;
    let repo: SupabaseHandshakeRepository;

    beforeAll(async () => {
        const url = process.env.SUPABASE_URL;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !serviceKey) throw new Error(
            'Missing env vars. Run: supabase start',
        );

        supabase = createClient(url, serviceKey, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
        repo = new SupabaseHandshakeRepository(supabase);

        // Setup: empresa y empleado de test (FK constraints)
        await supabase.from('companies').upsert({
            id: TEST_COMPANY_ID,
            name: 'Integration Test Company',
            allow_employee_swap: false,
            auto_notification: false,
        });
        await supabase.from('employees').upsert({
            id: TEST_EMPLOYEE_ID,
            company_id: TEST_COMPANY_ID,
            name: 'Handshake Test Employee',
            phone_number: '+12025550200',
            hire_date: '2023-01-01',
            experience_months: 12,
        });
    });

    afterAll(async () => {
        await supabase.from('whatsapp_handshakes').delete().eq('employee_id', TEST_EMPLOYEE_ID);
        await supabase.from('employees').delete().eq('id', TEST_EMPLOYEE_ID);
        await supabase.from('companies').delete().eq('id', TEST_COMPANY_ID);
    });

    afterEach(async () => {
        await supabase
            .from('whatsapp_handshakes')
            .delete()
            .in('id', [TEST_HANDSHAKE_ID_1, TEST_HANDSHAKE_ID_2]);
    });

    // ─── save ─────────────────────────────────────────────────────────────────

    describe('save()', () => {
        it('should persist a new handshake with token and expiry', async () => {
            // HandshakeToken.create valida UUID v4 — usamos el ID que SÍ es v4
            const token = HandshakeToken.create(TEST_HANDSHAKE_ID_1, 15);
            const handshake = WhatsappHandshake.initiate(
                TEST_HANDSHAKE_ID_1,
                TEST_EMPLOYEE_ID,
                '+12025550200',
                token,
            );

            await repo.save(handshake, token.value, token.expiresAt);

            const { data } = await supabase
                .from('whatsapp_handshakes')
                .select('id, employee_id, token, verified')
                .eq('id', TEST_HANDSHAKE_ID_1)
                .single();

            expect(data).not.toBeNull();
            expect(data!.id).toBe(TEST_HANDSHAKE_ID_1);
            expect(data!.employee_id).toBe(TEST_EMPLOYEE_ID);
            expect(data!.token).toBe(TEST_HANDSHAKE_ID_1);
            expect(data!.verified).toBe(false);
        });
    });

    // ─── findById ─────────────────────────────────────────────────────────────

    describe('findById()', () => {
        it('should return null when handshake does not exist', async () => {
            const result = await repo.findById('ffffffff-0000-4000-8000-000000000001');
            expect(result).toBeNull();
        });

        it('should retrieve handshake data with phone from employees join', async () => {
            const expiresAt = new Date(Date.now() + 15 * 60_000);
            await supabase.from('whatsapp_handshakes').insert({
                id: TEST_HANDSHAKE_ID_1,
                employee_id: TEST_EMPLOYEE_ID,
                token: TEST_HANDSHAKE_ID_1,
                expires_at: expiresAt.toISOString(),
                verified: false,
            });

            const result = await repo.findById(TEST_HANDSHAKE_ID_1);

            expect(result).not.toBeNull();
            expect(result!.employeeId).toBe(TEST_EMPLOYEE_ID);
            expect(result!.token).toBe(TEST_HANDSHAKE_ID_1);
            expect(result!.verified).toBe(false);
            expect(result!.phone).toBe('+12025550200');
            expect(result!.expiresAt).toBeInstanceOf(Date);
        });
    });

    // ─── markVerified ─────────────────────────────────────────────────────────

    describe('markVerified()', () => {
        it('should set verified = true for the handshake', async () => {
            const expiresAt = new Date(Date.now() + 15 * 60_000);
            await supabase.from('whatsapp_handshakes').insert({
                id: TEST_HANDSHAKE_ID_1,
                employee_id: TEST_EMPLOYEE_ID,
                token: TEST_HANDSHAKE_ID_1,
                expires_at: expiresAt.toISOString(),
                verified: false,
            });

            await repo.markVerified(TEST_HANDSHAKE_ID_1);

            const { data } = await supabase
                .from('whatsapp_handshakes')
                .select('verified')
                .eq('id', TEST_HANDSHAKE_ID_1)
                .single();

            expect(data?.verified).toBe(true);
        });
    });

    // ─── Flujo completo ───────────────────────────────────────────────────────

    describe('Full handshake flow', () => {
        it('should persist → retrieve → mark verified', async () => {
            // 1. Initiate & save
            const token = HandshakeToken.create(TEST_HANDSHAKE_ID_2, 15);
            const handshake = WhatsappHandshake.initiate(
                TEST_HANDSHAKE_ID_2,
                TEST_EMPLOYEE_ID,
                '+12025550200',
                token,
            );
            await repo.save(handshake, token.value, token.expiresAt);

            // 2. Retrieve
            const data = await repo.findById(TEST_HANDSHAKE_ID_2);
            expect(data).not.toBeNull();
            expect(data!.verified).toBe(false);

            // 3. Mark verified
            await repo.markVerified(TEST_HANDSHAKE_ID_2);
            const verified = await repo.findById(TEST_HANDSHAKE_ID_2);
            expect(verified!.verified).toBe(true);
        });
    });
});

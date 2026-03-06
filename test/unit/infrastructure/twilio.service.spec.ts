/**
 * 🧪 UNIT TEST: TwilioService
 *
 * El SDK de Twilio está completamente mockeado para:
 *  - No hacer llamadas HTTP reales
 *  - No requerir credenciales en CI/CD
 *  - Testear que el servicio pasa los argumentos correctos
 *
 * 💡 Estrategia de mock:
 *    `require('twilio')` devuelve una función callable que construye
 *    el cliente Twilio. El mock reemplaza esa función y controla
 *    el cliente devuelto sin TDZ issues.
 */

// Objeto intermedio para capturar el mock sin TDZ
const twilioMock = {
    messagesCreate: jest.fn(),
};

// jest.mock() es hoisted — el factory se ejecuta antes de los imports.
// Devolvemos una función callable (igual que el módulo Twilio real).
jest.mock('twilio', () =>
    jest.fn(() => ({
        messages: { create: twilioMock.messagesCreate },
    })),
);

// Importar DESPUÉS del mock
import { TwilioService } from '../../../src/infrastructure/notifications/twilio.service';
import { ConfigService } from '@nestjs/config';

const MOCK_ACCOUNT_SID = 'ACtest00000000000000000000000000000';
const MOCK_AUTH_TOKEN = 'test_auth_token_00000000000000000000';
const MOCK_FROM_NUMBER = '+14155238886';

function buildService(): TwilioService {
    const configService = {
        getOrThrow: jest.fn((key: string) => {
            const map: Record<string, string> = {
                'twilio.accountSid': MOCK_ACCOUNT_SID,
                'twilio.authToken': MOCK_AUTH_TOKEN,
                'twilio.fromNumber': MOCK_FROM_NUMBER,
            };
            if (!map[key]) throw new Error(`Config key ${key} not found`);
            return map[key];
        }),
    } as unknown as ConfigService;

    return new TwilioService(configService);
}

describe('TwilioService', () => {
    let service: TwilioService;

    beforeEach(() => {
        jest.clearAllMocks();
        service = buildService();
    });

    describe('sendWhatsApp()', () => {
        it('should call twilio.messages.create with whatsapp: prefix', async () => {
            twilioMock.messagesCreate.mockResolvedValueOnce({ sid: 'SM123', status: 'queued' });

            await service.sendWhatsApp('+34612345678', 'Test message');

            expect(twilioMock.messagesCreate).toHaveBeenCalledTimes(1);
            expect(twilioMock.messagesCreate).toHaveBeenCalledWith({
                from: `whatsapp:${MOCK_FROM_NUMBER}`,
                to: 'whatsapp:+34612345678',
                body: 'Test message',
            });
        });

        it('should resolve without error on successful send', async () => {
            twilioMock.messagesCreate.mockResolvedValueOnce({ sid: 'SM456', status: 'sent' });

            await expect(
                service.sendWhatsApp('+12025550101', 'Hello!'),
            ).resolves.not.toThrow();
        });

        it('should throw Error when Twilio SDK rejects', async () => {
            twilioMock.messagesCreate.mockRejectedValueOnce(new Error('Invalid phone number'));

            await expect(
                service.sendWhatsApp('+00000000000', 'Test'),
            ).rejects.toThrow('Notification failed: Invalid phone number');
        });

        it('should use whatsapp: prefix for both from and to', async () => {
            twilioMock.messagesCreate.mockResolvedValueOnce({ sid: 'SM789', status: 'queued' });

            await service.sendWhatsApp('+34699887766', 'message');

            const callArgs = twilioMock.messagesCreate.mock.calls[0][0];
            expect(callArgs.from).toMatch(/^whatsapp:/);
            expect(callArgs.to).toMatch(/^whatsapp:/);
        });

        it('should send the exact body provided', async () => {
            const body = '🔐 Tu verificación es: 1234-5678. Expira en 15 min.';
            twilioMock.messagesCreate.mockResolvedValueOnce({ sid: 'SM000', status: 'queued' });

            await service.sendWhatsApp('+34612345678', body);

            expect(twilioMock.messagesCreate.mock.calls[0][0].body).toBe(body);
        });
    });
});

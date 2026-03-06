import { HandshakeInitiatedHandler } from '../../../src/application/handlers/handshake-initiated.handler';
import { HandshakeInitiatedEvent } from '../../../src/domain/events/handshake-initiated.event';
import type { INotificationService } from '../../../src/domain/services/notification.service';

/**
 * 🧪 UNIT TEST: HandshakeInitiatedHandler
 *
 * Verifica que el handler delega correctamente el envío del token
 * al INotificationService — sin conocer Twilio.
 */
describe('HandshakeInitiatedHandler', () => {
    let handler: HandshakeInitiatedHandler;
    let notificationService: jest.Mocked<INotificationService>;

    beforeEach(() => {
        notificationService = { sendWhatsApp: jest.fn().mockResolvedValue(undefined) };
        handler = new HandshakeInitiatedHandler(notificationService);
    });

    it('should send a WhatsApp message with the token to the employee phone', async () => {
        const event = new HandshakeInitiatedEvent(
            'employee-001',
            '+34612345678',
            'cccccccc-0000-4000-8000-000000000001',
        );

        await handler.handle(event);

        expect(notificationService.sendWhatsApp).toHaveBeenCalledTimes(1);
        const [toArg, bodyArg] = notificationService.sendWhatsApp.mock.calls[0];
        expect(toArg).toBe('+34612345678');
        expect(bodyArg).toContain('cccccccc-0000-4000-8000-000000000001');
        expect(bodyArg).toContain('15 minutos');
    });

    it('should propagate errors from notificationService', async () => {
        notificationService.sendWhatsApp.mockRejectedValueOnce(
            new Error('Notification failed: Twilio error'),
        );
        const event = new HandshakeInitiatedEvent(
            'employee-001',
            '+34612345678',
            'cccccccc-0000-4000-8000-000000000001',
        );

        await expect(handler.handle(event)).rejects.toThrow('Notification failed');
    });

    it('should not hard-code phone — uses event.phone directly', async () => {
        const differentPhone = '+12025550199';
        const event = new HandshakeInitiatedEvent(
            'e-002', differentPhone, 'dddddddd-0000-4000-8000-000000000002',
        );

        await handler.handle(event);

        expect(notificationService.sendWhatsApp.mock.calls[0][0]).toBe(differentPhone);
    });
});

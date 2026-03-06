import { EmployeeRegisteredHandler } from '../../../src/application/handlers/employee-registered.handler';
import { EmployeeRegisteredEvent } from '../../../src/domain/events/employee-registered.event';
import type { INotificationService } from '../../../src/domain/services/notification.service';

/**
 * 🧪 UNIT TEST: EmployeeRegisteredHandler
 *
 * Verificamos que el handler envía el mensaje de bienvenida vía INotificationService.
 * El servicio de notificaciones está completamente mockeado — sin Twilio real.
 */
describe('EmployeeRegisteredHandler', () => {
    let handler: EmployeeRegisteredHandler;
    let notificationService: jest.Mocked<INotificationService>;

    beforeEach(() => {
        notificationService = { sendWhatsApp: jest.fn().mockResolvedValue(undefined) };
        handler = new EmployeeRegisteredHandler(notificationService);
    });

    it('should send a welcome WhatsApp message to the employee phone', async () => {
        const event = new EmployeeRegisteredEvent(
            'employee-1',
            'company-1',
            '+12025550100',
        );

        await handler.handle(event);

        expect(notificationService.sendWhatsApp).toHaveBeenCalledTimes(1);
        const [toArg, bodyArg] = notificationService.sendWhatsApp.mock.calls[0];
        expect(toArg).toBe('+12025550100');
        expect(bodyArg).toContain('Bienvenido');
    });

    it('should use event.phone — no hardcoded phone numbers', async () => {
        const phone = '+19995551234';
        const event = new EmployeeRegisteredEvent('emp-2', 'co-2', phone);

        await handler.handle(event);

        expect(notificationService.sendWhatsApp.mock.calls[0][0]).toBe(phone);
    });

    it('should propagate errors from notificationService', async () => {
        notificationService.sendWhatsApp.mockRejectedValueOnce(
            new Error('Notification failed: Twilio error'),
        );
        const event = new EmployeeRegisteredEvent('emp-3', 'co-3', '+12025550103');

        await expect(handler.handle(event)).rejects.toThrow('Notification failed');
    });
});

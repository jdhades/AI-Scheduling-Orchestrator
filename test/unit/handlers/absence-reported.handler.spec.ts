import { Test, TestingModule } from '@nestjs/testing';
import { AbsenceReportedHandler } from '../../../src/application/handlers/absence-reported.handler';
import { AbsenceReportedEvent } from '../../../src/domain/events/absence-reported.event';
import { INotificationService, NOTIFICATION_SERVICE } from '../../../src/domain/services/notification.service';
import { EMPLOYEE_REPOSITORY, IEmployeeRepository } from '../../../src/domain/repositories/employee.repository';
import { Employee } from '../../../src/domain/aggregates/employee.aggregate';

describe('AbsenceReportedHandler', () => {
    let handler: AbsenceReportedHandler;
    let mockEmployeeRepo: jest.Mocked<IEmployeeRepository>;
    let mockNotificationService: jest.Mocked<INotificationService>;

    const originalEnv = process.env;

    beforeEach(async () => {
        jest.resetModules();
        process.env = { ...originalEnv, MANAGER_WHATSAPP_NUMBER: '+99999999999' };

        mockEmployeeRepo = {
            findById: jest.fn(),
            findByPhone: jest.fn(),
            findAllByCompany: jest.fn(),
            save: jest.fn(),
            update: jest.fn(),
        } as any;

        mockNotificationService = {
            sendWhatsApp: jest.fn().mockResolvedValue(undefined),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AbsenceReportedHandler,
                { provide: EMPLOYEE_REPOSITORY, useValue: mockEmployeeRepo },
                { provide: NOTIFICATION_SERVICE, useValue: mockNotificationService },
            ],
        }).compile();

        handler = module.get<AbsenceReportedHandler>(AbsenceReportedHandler);
    });

    afterEach(() => {
        process.env = originalEnv;
        jest.clearAllMocks();
    });

    it('should send an urgent notification to the manager if absence is urgent', async () => {
        const employee = { id: 'emp-1', phone: '+1234567890' } as unknown as Employee;
        mockEmployeeRepo.findById.mockResolvedValue(employee);

        const event = new AbsenceReportedEvent('emp-1', 'shift-1', 'Sick', 'comp-1', true);
        await handler.handle(event);

        expect(mockEmployeeRepo.findById).toHaveBeenCalledWith('emp-1', 'comp-1');
        expect(mockNotificationService.sendWhatsApp).toHaveBeenCalledWith(
            '+99999999999',
            expect.stringContaining('🚨 *ALERTA URGENTE*')
        );
        const messageArg = mockNotificationService.sendWhatsApp.mock.calls[0][1];
        expect(messageArg).toContain('+1234567890');
        expect(messageArg).toContain('shift-1');
        expect(messageArg).toContain('Sick');
        expect(messageArg).toContain('🔴 Se necesita reemplazo urgente.');
    });

    it('should send a standard notification to the manager if absence is not urgent', async () => {
        const employee = { id: 'emp-1', phone: '+1234567890' } as unknown as Employee;
        mockEmployeeRepo.findById.mockResolvedValue(employee);

        const event = new AbsenceReportedEvent('emp-1', 'shift-1', 'Vacation', 'comp-1', false);
        await handler.handle(event);

        expect(mockNotificationService.sendWhatsApp).toHaveBeenCalledWith(
            '+99999999999',
            expect.stringContaining('⚠️ *Ausencia reportada*')
        );
        const messageArg = mockNotificationService.sendWhatsApp.mock.calls[0][1];
        expect(messageArg).toContain('Se necesita reasignar el turno.');
        expect(messageArg).toContain('Vacation');
    });

    it('should not send notification if employee is not found', async () => {
        mockEmployeeRepo.findById.mockResolvedValue(null);

        const event = new AbsenceReportedEvent('emp-1', 'shift-1', 'Sick', 'comp-1', false);
        await handler.handle(event);

        expect(mockNotificationService.sendWhatsApp).not.toHaveBeenCalled();
    });

    it('should not throw error if MANAGER_WHATSAPP_NUMBER is not set, just log warning', async () => {
        // We override the process.env before recompiling module
        process.env.MANAGER_WHATSAPP_NUMBER = '';

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AbsenceReportedHandler,
                { provide: EMPLOYEE_REPOSITORY, useValue: mockEmployeeRepo },
                { provide: NOTIFICATION_SERVICE, useValue: mockNotificationService },
            ],
        }).compile();

        const handlerWithoutManager = module.get<AbsenceReportedHandler>(AbsenceReportedHandler);

        const employee = { id: 'emp-1', phone: '+1234567890' } as unknown as Employee;
        mockEmployeeRepo.findById.mockResolvedValue(employee);

        const event = new AbsenceReportedEvent('emp-1', 'shift-1', 'Sick', 'comp-1', false);
        // Spy on Logger using prototype or spy behavior since it's instantiated inside the class

        await expect(handlerWithoutManager.handle(event)).resolves.not.toThrow();
        expect(mockNotificationService.sendWhatsApp).not.toHaveBeenCalled();
    });
});

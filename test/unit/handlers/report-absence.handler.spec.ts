import { Test, TestingModule } from '@nestjs/testing';
import { EventBus } from '@nestjs/cqrs';
import { ReportAbsenceHandler } from '../../../src/application/handlers/report-absence.handler';
import { ReportAbsenceCommand } from '../../../src/application/commands/report-absence.command';
import { AbsenceReportedEvent } from '../../../src/domain/events/absence-reported.event';
import { EMPLOYEE_REPOSITORY, IEmployeeRepository } from '../../../src/domain/repositories/employee.repository';
import { SHIFT_REPOSITORY, IShiftRepository } from '../../../src/domain/repositories/shift.repository';
import { Employee } from '../../../src/domain/aggregates/employee.aggregate';
import { Shift } from '../../../src/domain/aggregates/shift.aggregate';
import { ShiftAssignment } from '../../../src/domain/aggregates/shift-assignment.aggregate';

describe('ReportAbsenceHandler', () => {
    let handler: ReportAbsenceHandler;
    let mockEmployeeRepo: jest.Mocked<IEmployeeRepository>;
    let mockShiftRepo: jest.Mocked<IShiftRepository>;
    let mockEventBus: jest.Mocked<EventBus>;

    beforeEach(async () => {
        mockEmployeeRepo = {
            findById: jest.fn(),
            findByPhone: jest.fn(),
            findAllByCompany: jest.fn(),
            save: jest.fn(),
            update: jest.fn(),
        } as any;

        mockShiftRepo = {
            findById: jest.fn(),
            findByCompanyAndWeek: jest.fn(),
            findAssignmentsByEmployee: jest.fn(),
            save: jest.fn(),
            assignEmployee: jest.fn(),
            removeAssignment: jest.fn(),
        } as any;

        mockEventBus = {
            publish: jest.fn(),
        } as any;

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ReportAbsenceHandler,
                { provide: EMPLOYEE_REPOSITORY, useValue: mockEmployeeRepo },
                { provide: SHIFT_REPOSITORY, useValue: mockShiftRepo },
                { provide: EventBus, useValue: mockEventBus },
            ],
        }).compile();

        handler = module.get<ReportAbsenceHandler>(ReportAbsenceHandler);
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    it('should successfully emit absence reported event (not urgent)', async () => {
        const now = new Date('2026-03-05T12:00:00Z');
        jest.setSystemTime(now);

        const requester = { id: 'req-1' } as Employee;
        const shift = {
            id: 'shift-1',
            startTime: new Date('2026-03-05T16:00:00Z') // 4 hours away -> not urgent
        } as unknown as Shift;

        mockEmployeeRepo.findById.mockResolvedValue(requester);
        mockShiftRepo.findAssignmentsByEmployee.mockResolvedValue([
            ShiftAssignment.create({ id: 'a1', shiftId: 'shift-1', employeeId: 'req-1', companyId: 'comp-1', strategyType: 'HYBRID' as any, fairnessSnapshot: {} })
        ]);
        mockShiftRepo.findByCompanyAndWeek.mockResolvedValue([shift]);

        const command = new ReportAbsenceCommand('req-1', 'shift-1', 'Sick', 'comp-1');
        await handler.execute(command);

        expect(mockEventBus.publish).toHaveBeenCalledWith(expect.any(AbsenceReportedEvent));
        const eventArgs = mockEventBus.publish.mock.calls[0][0] as AbsenceReportedEvent;
        expect(eventArgs.employeeId).toBe('req-1');
        expect(eventArgs.shiftId).toBe('shift-1');
        expect(eventArgs.reason).toBe('Sick');
        expect(eventArgs.isUrgent).toBe(false);
    });

    it('should flag the absence as urgent if shift starts in less than 2 hours', async () => {
        const now = new Date('2026-03-05T12:00:00Z');
        jest.setSystemTime(now);

        const requester = { id: 'req-1' } as Employee;
        const shift = {
            id: 'shift-1',
            startTime: new Date('2026-03-05T13:00:00Z') // 1 hour away -> urgent
        } as unknown as Shift;

        mockEmployeeRepo.findById.mockResolvedValue(requester);
        mockShiftRepo.findAssignmentsByEmployee.mockResolvedValue([
            ShiftAssignment.create({ id: 'a2', shiftId: 'shift-1', employeeId: 'req-1', companyId: 'comp-1', strategyType: 'HYBRID' as any, fairnessSnapshot: {} })
        ]);
        mockShiftRepo.findByCompanyAndWeek.mockResolvedValue([shift]);

        const command = new ReportAbsenceCommand('req-1', 'shift-1', 'Car breakdown', 'comp-1');
        await handler.execute(command);

        const eventArgs = mockEventBus.publish.mock.calls[0][0] as AbsenceReportedEvent;
        expect(eventArgs.isUrgent).toBe(true);
    });

    it('should throw an error if the employee is not found', async () => {
        mockEmployeeRepo.findById.mockResolvedValue(null);
        const command = new ReportAbsenceCommand('bad-id', 'shift-id', 'Sick', 'comp-1');
        await expect(handler.execute(command)).rejects.toThrow('Employee not found');
    });

    it('should throw an error if the shift is not assigned to the employee', async () => {
        const requester = { id: 'req-1' } as Employee;
        mockEmployeeRepo.findById.mockResolvedValue(requester);
        mockShiftRepo.findAssignmentsByEmployee.mockResolvedValue([]); // Unassigned

        const command = new ReportAbsenceCommand('req-1', 'shift-id', 'Sick', 'comp-1');
        await expect(handler.execute(command)).rejects.toThrow('Shift shift-id is not assigned to employee');
    });
});

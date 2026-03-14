import { Test, TestingModule } from '@nestjs/testing';
import { GetMyScheduleHandler } from '../../../src/application/handlers/get-my-schedule.handler';
import { GetMyScheduleQuery } from '../../../src/application/queries/get-my-schedule.query';
import { SHIFT_REPOSITORY, IShiftRepository } from '../../../src/domain/repositories/shift.repository';
import { Shift } from '../../../src/domain/aggregates/shift.aggregate';
import { ShiftAssignment } from '../../../src/domain/aggregates/shift-assignment.aggregate';

describe('GetMyScheduleHandler', () => {
    let handler: GetMyScheduleHandler;
    let mockShiftRepo: jest.Mocked<IShiftRepository>;

    beforeEach(async () => {
        mockShiftRepo = {
            findById: jest.fn(),
            findByCompanyAndWeek: jest.fn(),
            findAssignmentsByEmployee: jest.fn(),
            save: jest.fn(),
            assignEmployee: jest.fn(),
            removeAssignment: jest.fn(),
        } as any;

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                GetMyScheduleHandler,
                { provide: SHIFT_REPOSITORY, useValue: mockShiftRepo },
            ],
        }).compile();

        handler = module.get<GetMyScheduleHandler>(GetMyScheduleHandler);

        jest.useFakeTimers();
        const now = new Date('2026-03-02T12:00:00Z'); // 2026-03-02 is Monday
        jest.setSystemTime(now);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('should return a message if the employee has no shifts', async () => {
        mockShiftRepo.findAssignmentsByEmployee.mockResolvedValue([]);

        const result = await handler.execute(new GetMyScheduleQuery('emp-1', 'comp-1'));

        expect(result).toBe('📅 No tienes turnos asignados esta semana.');
        expect(mockShiftRepo.findAssignmentsByEmployee).toHaveBeenCalledWith(
            'emp-1', 'comp-1', expect.any(Date), expect.any(Date)
        );
    });

    it('should format and return the employee schedule', async () => {
        const monday = new Date('2026-03-02T08:00:00Z');

        const shift1 = {
            id: 'shift-1',
            startTime: new Date('2026-03-02T08:00:00Z'),
            endTime: new Date('2026-03-02T16:00:00Z'),
        } as unknown as Shift;

        const shift2 = {
            id: 'shift-2',
            startTime: new Date('2026-03-03T10:00:00Z'),
            endTime: new Date('2026-03-03T18:00:00Z'),
        } as unknown as Shift;

        mockShiftRepo.findAssignmentsByEmployee.mockResolvedValue([
            ShiftAssignment.create({ id: 'a1', shiftId: 'shift-1', employeeId: 'emp-1', companyId: 'comp-1', strategyType: 'HYBRID' as any, fairnessSnapshot: {} }),
            ShiftAssignment.create({ id: 'a2', shiftId: 'shift-2', employeeId: 'emp-1', companyId: 'comp-1', strategyType: 'HYBRID' as any, fairnessSnapshot: {} }),
        ]);

        mockShiftRepo.findByCompanyAndWeek.mockResolvedValue([shift1, shift2]);

        const result = await handler.execute(new GetMyScheduleQuery('emp-1', 'comp-1', monday.toISOString()));

        expect(result).toContain('📅 *Tu horario esta semana:*');
        expect(result).toContain('¿Necesitas algo más?');
    });

    it('should calculate current monday properly when weekStart is not provided', async () => {
        mockShiftRepo.findAssignmentsByEmployee.mockResolvedValue([]);

        await handler.execute(new GetMyScheduleQuery('emp-1', 'comp-1'));

        const callArgs = mockShiftRepo.findAssignmentsByEmployee.mock.calls[0];
        const monday = callArgs[2] as Date;
        expect(monday.getDay()).toBe(1); // 1 = Monday
        expect(monday.getHours()).toBe(0);
        expect(monday.getMinutes()).toBe(0);
    });
});

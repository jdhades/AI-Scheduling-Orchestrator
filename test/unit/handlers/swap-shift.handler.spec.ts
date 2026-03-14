import { Test, TestingModule } from '@nestjs/testing';
import { EventBus } from '@nestjs/cqrs';
import { SwapShiftHandler } from '../../../src/application/handlers/swap-shift.handler';
import { SwapShiftCommand } from '../../../src/application/commands/swap-shift.command';
import { ShiftSwapRequestedEvent } from '../../../src/domain/events/shift-swap-requested.event';
import { EMPLOYEE_REPOSITORY, IEmployeeRepository } from '../../../src/domain/repositories/employee.repository';
import { SHIFT_REPOSITORY, IShiftRepository } from '../../../src/domain/repositories/shift.repository';
import { Employee } from '../../../src/domain/aggregates/employee.aggregate';
import { Shift } from '../../../src/domain/aggregates/shift.aggregate';
import { ShiftAssignment } from '../../../src/domain/aggregates/shift-assignment.aggregate';

describe('SwapShiftHandler', () => {
    let handler: SwapShiftHandler;
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
                SwapShiftHandler,
                { provide: EMPLOYEE_REPOSITORY, useValue: mockEmployeeRepo },
                { provide: SHIFT_REPOSITORY, useValue: mockShiftRepo },
                { provide: EventBus, useValue: mockEventBus },
            ],
        }).compile();

        handler = module.get<SwapShiftHandler>(SwapShiftHandler);
        jest.clearAllMocks();
    });

    it('should successfully emit a shift swap requested event', async () => {
        const requester = { id: 'req-1' } as Employee;
        const target = { id: 'tgt-1' } as Employee;
        const shift = {
            id: 'shift-1',
            overlapsWith: jest.fn().mockReturnValue(false)
        } as unknown as Shift;

        mockEmployeeRepo.findById.mockResolvedValue(requester);
        mockEmployeeRepo.findByPhone.mockResolvedValue(target);

        mockShiftRepo.findAssignmentsByEmployee.mockImplementation(async (empId) => {
            if (empId === 'req-1') {
                return [ShiftAssignment.create({ id: 'a1', shiftId: 'shift-1', employeeId: 'req-1', companyId: 'c1', strategyType: 'HYBRID' as any, fairnessSnapshot: {} })];
            }
            return [];
        });

        mockShiftRepo.findByCompanyAndWeek.mockResolvedValue([shift]);

        const command = new SwapShiftCommand('req-1', '+123', 'shift-1', 'comp-1');
        const result = await handler.execute(command);

        expect(result.swapRequestId).toMatch(/^swap-\d+$/);
        expect(mockEventBus.publish).toHaveBeenCalledWith(expect.any(ShiftSwapRequestedEvent));
    });

    it('should throw an error if the requester is not found', async () => {
        mockEmployeeRepo.findById.mockResolvedValue(null);
        const command = new SwapShiftCommand('bad-id', '+123', 'shift-1', 'comp-1');
        await expect(handler.execute(command)).rejects.toThrow('Requester employee not found');
    });

    it('should throw an error if the target employee is not found', async () => {
        mockEmployeeRepo.findById.mockResolvedValue({ id: 'req-1' } as Employee);
        mockEmployeeRepo.findByPhone.mockResolvedValue(null);

        const command = new SwapShiftCommand('req-1', '+123', 'shift-1', 'comp-1');
        await expect(handler.execute(command)).rejects.toThrow('No employee found with phone +123');
    });

    it('should throw an error if the requester is not assigned to the requested shift', async () => {
        mockEmployeeRepo.findById.mockResolvedValue({ id: 'req-1' } as Employee);
        mockEmployeeRepo.findByPhone.mockResolvedValue({ id: 'tgt-1' } as Employee);

        // Return empty assignments for the requester
        mockShiftRepo.findAssignmentsByEmployee.mockResolvedValue([]);

        const command = new SwapShiftCommand('req-1', '+123', 'shift-1', 'comp-1');
        await expect(handler.execute(command)).rejects.toThrow('Shift shift-1 is not assigned to the requesting employee');
    });

    it('should throw an error if the target employee has a time slot conflict', async () => {
        const requester = { id: 'req-1' } as Employee;
        const target = { id: 'tgt-1' } as Employee;

        const shiftToSwap = {
            id: 'shift-1',
            overlapsWith: jest.fn().mockReturnValue(true) // Simulating overlap
        } as unknown as Shift;

        const conflictingShift = { id: 'shift-2' } as Shift;

        mockEmployeeRepo.findById.mockResolvedValue(requester);
        mockEmployeeRepo.findByPhone.mockResolvedValue(target);

        mockShiftRepo.findByCompanyAndWeek.mockResolvedValue([shiftToSwap, conflictingShift]);

        mockShiftRepo.findAssignmentsByEmployee.mockImplementation(async (empId) => {
            if (empId === 'req-1') {
                return [ShiftAssignment.create({ id: 'a1', shiftId: 'shift-1', employeeId: 'req-1', companyId: 'c1', strategyType: 'HYBRID' as any, fairnessSnapshot: {} })];
            }
            if (empId === 'tgt-1') {
                return [ShiftAssignment.create({ id: 'a2', shiftId: 'shift-2', employeeId: 'tgt-1', companyId: 'c1', strategyType: 'HYBRID' as any, fairnessSnapshot: {} })];
            }
            return [];
        });

        const command = new SwapShiftCommand('req-1', '+123', 'shift-1', 'comp-1');
        await expect(handler.execute(command)).rejects.toThrow('Target employee has a conflicting shift on that time slot');
    });
});

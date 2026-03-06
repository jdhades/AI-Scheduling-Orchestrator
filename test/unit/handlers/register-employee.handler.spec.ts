import { EventPublisher } from '@nestjs/cqrs';
import { RegisterEmployeeHandler } from '../../../src/application/handlers/register-employee.handler';
import { RegisterEmployeeCommand } from '../../../src/application/commands/register-employee.command';
import { PhoneNumber } from '../../../src/domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../../src/domain/value-objects/experience-level.vo';
import { Employee } from '../../../src/domain/aggregates/employee.aggregate';
import type { IEmployeeRepository } from '../../../src/domain/repositories/employee.repository';

describe('RegisterEmployeeHandler', () => {
    let handler: RegisterEmployeeHandler;
    let mockPublisher: jest.Mocked<EventPublisher>;
    let mockEmployeeRepo: jest.Mocked<IEmployeeRepository>;

    const RANGES = { junior: 6, intermediate: 24, senior: 999 };

    beforeEach(() => {
        mockPublisher = {
            mergeObjectContext: jest.fn((aggregate: Employee) => {
                jest.spyOn(aggregate, 'commit').mockImplementation(() => { });
                return aggregate;
            }),
        } as unknown as jest.Mocked<EventPublisher>;

        mockEmployeeRepo = {
            save: jest.fn().mockResolvedValue(undefined),
            findById: jest.fn(),
            findByPhone: jest.fn(),
            findAllByCompany: jest.fn().mockResolvedValue([]),
            markWhatsappVerified: jest.fn(),
        };

        handler = new RegisterEmployeeHandler(mockPublisher, mockEmployeeRepo);
    });

    it('should create an employee, save it, and commit domain events', async () => {
        const command = new RegisterEmployeeCommand(
            'employee-uuid-1',
            'company-uuid-1',
            PhoneNumber.create('+12025550100'),
            new ExperienceLevel(12, RANGES),
        );

        await handler.execute(command);

        expect(mockPublisher.mergeObjectContext).toHaveBeenCalledTimes(1);

        const aggregate = mockPublisher.mergeObjectContext.mock.calls[0][0] as Employee;
        expect(aggregate.id).toBe('employee-uuid-1');
        expect(aggregate.companyId).toBe('company-uuid-1');
        expect(mockEmployeeRepo.save).toHaveBeenCalledWith(aggregate);
    });

    it('should call commit() after save()', async () => {
        const command = new RegisterEmployeeCommand(
            'employee-uuid-2',
            'company-uuid-2',
            PhoneNumber.create('+12025550199'),
            new ExperienceLevel(36, RANGES),
        );

        await handler.execute(command);

        const aggregate = mockPublisher.mergeObjectContext.mock.calls[0][0] as Employee;
        // save() must happen before commit() — checked by call order
        const saveOrder = (mockEmployeeRepo.save as jest.Mock).mock.invocationCallOrder[0];
        const commitOrder = (aggregate.commit as jest.Mock).mock.invocationCallOrder[0];
        expect(saveOrder).toBeLessThan(commitOrder);
        expect(aggregate.commit).toHaveBeenCalledTimes(1);
    });

    it('should propagate validation errors from the domain', () => {
        expect(() =>
            new RegisterEmployeeCommand(
                'emp-1',
                'co-1',
                PhoneNumber.create('invalid-phone'),
                new ExperienceLevel(12, RANGES),
            ),
        ).toThrow('Invalid phone number');
    });
});

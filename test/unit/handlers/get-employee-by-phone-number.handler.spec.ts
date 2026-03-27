import { Test, TestingModule } from '@nestjs/testing';
import { GetEmployeeByPhoneNumberHandler } from '../../../src/application/handlers/get-employee-by-phone-number.handler';
import { EMPLOYEE_REPOSITORY } from '../../../src/domain/repositories/employee.repository';
import { GetEmployeeByPhoneNumberQuery } from '../../../src/application/queries/get-employee-by-phone-number-query';
import { NotFoundException } from '@nestjs/common';
import { Employee } from '../../../src/domain/aggregates/employee.aggregate';
import { PhoneNumber } from '../../../src/domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../../src/domain/value-objects/experience-level.vo';

describe('GetEmployeeByPhoneNumberHandler', () => {
  let handler: GetEmployeeByPhoneNumberHandler;
  let repoMock: any;

  beforeEach(async () => {
    repoMock = {
      findByPhone: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetEmployeeByPhoneNumberHandler,
        { provide: EMPLOYEE_REPOSITORY, useValue: repoMock },
      ],
    }).compile();

    handler = module.get<GetEmployeeByPhoneNumberHandler>(
      GetEmployeeByPhoneNumberHandler,
    );
  });

  it('should return EmployeeDto when employee is found', async () => {
    const phone = PhoneNumber.create('+1234567890');
    const exp = new ExperienceLevel(12, {
      junior: 6,
      intermediate: 24,
      senior: 999,
    });
    const mockEmployee = Employee.create(
      'emp-1',
      'comp-1',
      'John Doe',
      'Barista',
      phone,
      exp,
    );
    repoMock.findByPhone.mockResolvedValue(mockEmployee);

    const query = new GetEmployeeByPhoneNumberQuery('+1234567890', 'comp-1');
    const result = await handler.execute(query);

    expect(result).toBeDefined();
    expect(result.id).toBe('emp-1');
    expect(result.name).toBe('John Doe');
    expect(result.phone).toBe('+1234567890');
  });

  it('should throw NotFoundException when employee is not found', async () => {
    repoMock.findByPhone.mockResolvedValue(null);

    const query = new GetEmployeeByPhoneNumberQuery('+1234567890', 'comp-1');

    await expect(handler.execute(query)).rejects.toThrow(NotFoundException);
    await expect(handler.execute(query)).rejects.toThrow(
      'Employee with phone number +1234567890 not found.',
    );
  });
});

import { CommandHandler, EventPublisher, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { RegisterEmployeeCommand } from '../commands/register-employee.command';
import { Employee } from '../../domain/aggregates/employee.aggregate';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';

@CommandHandler(RegisterEmployeeCommand)
export class RegisterEmployeeHandler implements ICommandHandler<RegisterEmployeeCommand> {
  constructor(
    private readonly publisher: EventPublisher,
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepository: IEmployeeRepository,
  ) {}

  async execute(command: RegisterEmployeeCommand): Promise<void> {
    const { employeeId, companyId, phone, experience } = command;

    const employee = this.publisher.mergeObjectContext(
      Employee.create(
        employeeId,
        companyId,
        'Desconocido',
        'employee',
        phone,
        experience,
      ),
    );

    await this.employeeRepository.save(employee);
    employee.commit();
  }
}

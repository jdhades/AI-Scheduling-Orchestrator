import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, NotFoundException } from '@nestjs/common';
import { UpdateEmployeeCommand } from '../commands/update-employee.command';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';

@CommandHandler(UpdateEmployeeCommand)
export class UpdateEmployeeHandler implements ICommandHandler<UpdateEmployeeCommand> {
  constructor(
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepository: IEmployeeRepository,
  ) {}

  async execute(command: UpdateEmployeeCommand): Promise<void> {
    const existing = await this.employeeRepository.findById(
      command.employeeId,
      command.companyId,
    );
    if (!existing) {
      throw new NotFoundException(
        `Employee ${command.employeeId} not found in company ${command.companyId}`,
      );
    }
    await this.employeeRepository.updatePartial(
      command.employeeId,
      command.companyId,
      command.patch,
    );
  }
}

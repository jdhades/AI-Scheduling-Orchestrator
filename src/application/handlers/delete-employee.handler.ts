import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, NotFoundException } from '@nestjs/common';
import { DeleteEmployeeCommand } from '../commands/delete-employee.command';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';

@CommandHandler(DeleteEmployeeCommand)
export class DeleteEmployeeHandler
  implements ICommandHandler<DeleteEmployeeCommand>
{
  constructor(
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepository: IEmployeeRepository,
  ) {}

  async execute(command: DeleteEmployeeCommand): Promise<void> {
    const existing = await this.employeeRepository.findById(
      command.employeeId,
      command.companyId,
    );
    if (!existing) {
      throw new NotFoundException(
        `Employee ${command.employeeId} not found in company ${command.companyId}`,
      );
    }
    await this.employeeRepository.softDelete(
      command.employeeId,
      command.companyId,
    );
  }
}

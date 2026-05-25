import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject, NotFoundException } from '@nestjs/common';
import { GetEmployeeByIdQuery } from '../queries/get-employee-by-id.query';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';

@QueryHandler(GetEmployeeByIdQuery)
export class GetEmployeeByIdHandler implements IQueryHandler<GetEmployeeByIdQuery> {
  constructor(
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepository: IEmployeeRepository,
  ) {}

  async execute(query: GetEmployeeByIdQuery): Promise<unknown> {
    const emp = await this.employeeRepository.findById(
      query.employeeId,
      query.companyId,
    );
    if (!emp) {
      throw new NotFoundException(
        `Employee ${query.employeeId} not found in company ${query.companyId}`,
      );
    }
    // Serialización plana para el cliente
    return {
      id: emp.id,
      companyId: emp.companyId,
      name: emp.name,
      role: emp.role,
      phone: emp.phone,
      experienceMonths: emp.experienceMonths,
      locale: emp.locale,
      departmentId: (emp as any).departmentId ?? null,
    };
  }
}

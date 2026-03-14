import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { GetCompanyEmployeesQuery } from '../queries/get-company-employees.query';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import type { Employee } from '../../domain/aggregates/employee.aggregate';

import { EmployeeDto, toEmployeeDto } from '../dtos/employee.dto';

// ─── Handler ──────────────────────────────────────────────────────────────────

@QueryHandler(GetCompanyEmployeesQuery)
export class GetCompanyEmployeesHandler implements IQueryHandler<GetCompanyEmployeesQuery, EmployeeDto[]> {
    constructor(
        @Inject(EMPLOYEE_REPOSITORY)
        private readonly employeeRepo: IEmployeeRepository,
    ) { }

    async execute(query: GetCompanyEmployeesQuery): Promise<EmployeeDto[]> {
        const employees = await this.employeeRepo.findAllByCompany(query.companyId);
        return employees.map(toEmployeeDto);
    }
}

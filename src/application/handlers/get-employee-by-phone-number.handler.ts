import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject, NotFoundException } from '@nestjs/common';
import { GetEmployeeByPhoneNumberQuery } from '../queries/get-employee-by-phone-number-query';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import { EmployeeDto, toEmployeeDto } from '../dtos/employee.dto';

@QueryHandler(GetEmployeeByPhoneNumberQuery)
export class GetEmployeeByPhoneNumberHandler implements IQueryHandler<GetEmployeeByPhoneNumberQuery, EmployeeDto> {
    constructor(
        @Inject(EMPLOYEE_REPOSITORY)
        private readonly employeeRepo: IEmployeeRepository,
    ) { }

    async execute(query: GetEmployeeByPhoneNumberQuery): Promise<EmployeeDto> {
        const employee = await this.employeeRepo.findByPhone(query.phoneNumber, query.companyId);

        if (!employee) {
            throw new NotFoundException(`Employee with phone number ${query.phoneNumber} not found.`);
        }

        return toEmployeeDto(employee);
    }
}

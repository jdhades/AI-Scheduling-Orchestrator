import { Query } from '@nestjs/cqrs';

export class GetEmployeeByPhoneNumberQuery {
  constructor(
    public readonly phoneNumber: string,
    public readonly companyId: string,
  ) {}
}

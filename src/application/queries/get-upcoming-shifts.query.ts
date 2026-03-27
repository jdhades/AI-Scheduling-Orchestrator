export class GetUpcomingShiftsQuery {
  constructor(
    readonly employeeId: string,
    readonly companyId: string,
    readonly limit: number = 5,
  ) {}
}

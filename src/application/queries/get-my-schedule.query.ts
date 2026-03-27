export class GetMyScheduleQuery {
  constructor(
    readonly employeeId: string,
    readonly companyId: string,
    readonly weekStart?: string, // ISO 8601 date (YYYY-MM-DD); defaults to current week
  ) {}
}

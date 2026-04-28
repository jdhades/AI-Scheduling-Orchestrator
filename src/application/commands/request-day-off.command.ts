export class RequestDayOffCommand {
  constructor(
    readonly employeeId: string,
    readonly date: string, // ISO 8601 date (YYYY-MM-DD)
    readonly reason: string,
    readonly companyId: string,
  ) {}
}

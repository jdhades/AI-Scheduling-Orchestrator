export class CreateIncidentCommand {
  constructor(
    public readonly companyId: string,
    public readonly employeeId: string,
    public readonly message: string,
    public readonly mediaUrl: string,
    /** Día al que se refiere el reporte (YYYY-MM-DD), o null. */
    public readonly occurredOn: string | null = null,
  ) {}
}

export class IncidentReportedEvent {
  public readonly timestamp: Date;

  constructor(
    public readonly incidentId: string,
    public readonly companyId: string,
    public readonly employeeId: string,
    public readonly payload: {
      type: string;
      status: string;
    },
  ) {
    this.timestamp = new Date();
  }
}

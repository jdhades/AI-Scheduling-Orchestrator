export class IncidentResolvedEvent {
  public readonly timestamp: Date;

  constructor(
    public readonly incidentId: string,
    public readonly companyId: string,
    public readonly employeeId: string,
    public readonly payload: {
      resolutionDetails: string;
    },
  ) {
    this.timestamp = new Date();
  }
}

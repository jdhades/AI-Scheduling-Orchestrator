export class IncidentValidatedEvent {
  public readonly timestamp: Date;

  constructor(
    public readonly incidentId: string,
    public readonly companyId: string,
    public readonly employeeId: string,
    public readonly payload: {
      validated: boolean;
      startDate: Date;
      endDate: Date;
    },
  ) {
    this.timestamp = new Date();
  }
}

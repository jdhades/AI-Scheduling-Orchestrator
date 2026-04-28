export class EvidenceAttachedEvent {
  public readonly timestamp: Date;

  constructor(
    public readonly incidentId: string,
    public readonly companyId: string,
    public readonly employeeId: string,
    public readonly payload: {
      evidenceUrl: string;
    },
  ) {
    this.timestamp = new Date();
  }
}

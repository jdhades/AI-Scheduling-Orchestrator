export class NegotiateReplacementCommand {
  constructor(
    public readonly incidentId: string,
    public readonly candidateEmployeeId: string,
    public readonly shiftId: string,
    public readonly companyId: string,
  ) {}
}

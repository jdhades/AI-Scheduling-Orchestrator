export class OpenShiftClaimedEvent {
  constructor(
    public readonly employeeId: string,
    public readonly oldShiftId: string,
    public readonly newShiftId: string,
    public readonly companyId: string,
  ) {}
}

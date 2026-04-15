export class TakeOpenShiftCommand {
  constructor(
    public readonly requesterId: string,
    public readonly currentAssignmentId: string,
    public readonly targetSlotKey: string,
    public readonly companyId: string,
  ) {}
}

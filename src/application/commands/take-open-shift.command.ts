export class TakeOpenShiftCommand {
  constructor(
    public readonly requesterId: string,
    public readonly currentShiftId: string,
    public readonly targetShiftId: string,
    public readonly companyId: string,
  ) {}
}

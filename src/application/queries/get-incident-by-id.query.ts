export class GetIncidentByIdQuery {
  constructor(
    public readonly incidentId: string,
    public readonly companyId: string,
  ) {}
}

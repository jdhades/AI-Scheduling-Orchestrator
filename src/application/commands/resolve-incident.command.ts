/**
 * Marca el incident como RESOLVED. Requiere estado
 * REPLACEMENT_ASSIGNED | VALIDATED | REPAIR_IN_PROGRESS.
 */
export class ResolveIncidentCommand {
  constructor(
    public readonly incidentId: string,
    public readonly companyId: string,
    public readonly details: string,
  ) {}
}

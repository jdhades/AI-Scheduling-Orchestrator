/**
 * Transición REJECTED aplicable desde cualquier estado salvo RESOLVED o
 * ya-REJECTED. Útil para que el manager rechace manualmente un pedido.
 */
export class RejectIncidentCommand {
  constructor(
    public readonly incidentId: string,
    public readonly companyId: string,
    public readonly reason: string,
  ) {}
}

import type { IncidentStatus } from '../../domain/aggregates/incident.aggregate';

export class GetIncidentsQuery {
  constructor(
    public readonly companyId: string,
    public readonly filter?: {
      employeeId?: string;
      status?: IncidentStatus | IncidentStatus[];
    },
  ) {}
}

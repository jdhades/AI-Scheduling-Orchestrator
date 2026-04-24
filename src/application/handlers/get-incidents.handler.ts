import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { GetIncidentsQuery } from '../queries/get-incidents.query';
import { IncidentRepository } from '../../infrastructure/database/incident.repository';
import type { Incident } from '../../domain/aggregates/incident.aggregate';

@QueryHandler(GetIncidentsQuery)
export class GetIncidentsHandler implements IQueryHandler<GetIncidentsQuery> {
  constructor(private readonly incidentRepo: IncidentRepository) {}

  async execute(query: GetIncidentsQuery): Promise<unknown[]> {
    const rows = await this.incidentRepo.findAllByCompany(
      query.companyId,
      query.filter,
    );
    return rows.map((i) => this.toDto(i));
  }

  private toDto(i: Incident): object {
    return {
      id: i.id,
      companyId: i.companyId,
      employeeId: i.employeeId,
      type: i.type,
      status: i.status,
      evidenceUrl: i.evidenceUrl,
      validated: i.validated,
      ocrConfidence: i.ocrConfidence,
      startDate: i.startDate ? i.startDate.toISOString().split('T')[0] : null,
      endDate: i.endDate ? i.endDate.toISOString().split('T')[0] : null,
      createdAt: i.createdAt.toISOString(),
      updatedAt: i.updatedAt.toISOString(),
    };
  }
}

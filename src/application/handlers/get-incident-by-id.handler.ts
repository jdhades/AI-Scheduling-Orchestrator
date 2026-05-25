import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { NotFoundException } from '@nestjs/common';
import { GetIncidentByIdQuery } from '../queries/get-incident-by-id.query';
import { IncidentRepository } from '../../infrastructure/database/incident.repository';

@QueryHandler(GetIncidentByIdQuery)
export class GetIncidentByIdHandler implements IQueryHandler<GetIncidentByIdQuery> {
  constructor(private readonly incidentRepo: IncidentRepository) {}

  async execute(query: GetIncidentByIdQuery): Promise<unknown> {
    const i = await this.incidentRepo.findById(
      query.incidentId,
      query.companyId,
    );
    if (!i) {
      throw new NotFoundException(
        `Incident ${query.incidentId} not found in company ${query.companyId}`,
      );
    }
    return {
      id: i.id,
      companyId: i.companyId,
      employeeId: i.employeeId,
      type: i.type,
      status: i.status,
      evidenceUrl: i.evidenceUrl,
      ocrText: i.ocrText,
      ocrConfidence: i.ocrConfidence,
      validated: i.validated,
      startDate: i.startDate ? i.startDate.toISOString().split('T')[0] : null,
      endDate: i.endDate ? i.endDate.toISOString().split('T')[0] : null,
      createdAt: i.createdAt.toISOString(),
      updatedAt: i.updatedAt.toISOString(),
    };
  }
}

import { Injectable } from '@nestjs/common';
import { Incident } from '../../domain/aggregates/incident.aggregate';

@Injectable()
export class IncidentRepository {
  private readonly incidents = new Map<string, Incident>();

  async save(incident: Incident): Promise<void> {
    this.incidents.set(incident.id, incident);
  }

  async findById(id: string): Promise<Incident | null> {
    return this.incidents.get(id) || null;
  }
}

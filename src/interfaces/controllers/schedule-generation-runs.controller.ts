import { Controller, Get, Query } from '@nestjs/common';
import {
  ScheduleGenerationRunsService,
  type ScheduleGenerationRunRow,
} from '../../domain/services/schedule-generation-runs.service';

/**
 * GET /schedule-generation-runs?companyId=...&limit=20
 *
 * Devuelve los últimos N runs (completed/failed/cancelled) ordenados
 * por createdAt desc. Read-only para el dashboard. Sin paginación
 * por ahora — limit=20 es suficiente; agregar `before/after` cursor
 * cuando aparezca un caso de uso (export histórico, página dedicada).
 */
@Controller('schedule-generation-runs')
export class ScheduleGenerationRunsController {
  constructor(
    private readonly runsService: ScheduleGenerationRunsService,
  ) {}

  @Get()
  async list(
    @Query('companyId') companyId: string,
    @Query('limit') limit?: string,
  ): Promise<ScheduleGenerationRunRow[]> {
    const n = Math.min(Math.max(parseInt(limit ?? '20', 10) || 20, 1), 100);
    return this.runsService.listRecent(companyId, n);
  }
}

import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import {
  FAIRNESS_HISTORY_REPOSITORY,
  type IFairnessHistoryRepository,
} from '../../domain/repositories/fairness-history.repository';
import type { FairnessHistoryVO } from '../../domain/value-objects/fairness-history.vo';

/**
 * FairnessHistoryController — read-only
 *
 * El fairness se acumula automáticamente en cada corrida de
 * GenerateHybridScheduleHandler. Este controller solo expone lectura
 * para que el frontend pueda mostrar el balance por empleado.
 *
 * GET /fairness-history?companyId=UUID&weekStart=YYYY-MM-DD
 *   → todos los empleados de la empresa para esa semana
 *
 * GET /fairness-history/:employeeId?companyId=UUID&weekStart=YYYY-MM-DD
 *   → un empleado puntual
 */
@Controller('fairness-history')
export class FairnessHistoryController {
  constructor(
    @Inject(FAIRNESS_HISTORY_REPOSITORY)
    private readonly fairnessRepo: IFairnessHistoryRepository,
  ) {}

  @Get()
  async listByWeek(
    @Query('companyId') companyId: string,
    @Query('weekStart') weekStart: string,
  ): Promise<object[]> {
    const week = this.parseWeekStart(weekStart);
    const rows = await this.fairnessRepo.findByWeek(companyId, week);
    return rows.map(this.toDto);
  }

  @Get(':employeeId')
  async getByEmployee(
    @Param('employeeId') employeeId: string,
    @Query('companyId') companyId: string,
    @Query('weekStart') weekStart: string,
  ): Promise<object> {
    const week = this.parseWeekStart(weekStart);
    const row = await this.fairnessRepo.findByEmployeeAndWeek(
      employeeId,
      companyId,
      week,
    );
    if (!row) {
      throw new NotFoundException(
        `FairnessHistory for employee ${employeeId} / week ${weekStart} not found`,
      );
    }
    return this.toDto(row);
  }

  private parseWeekStart(iso: string): Date {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      throw new BadRequestException(
        `weekStart query param must be YYYY-MM-DD, got: ${iso}`,
      );
    }
    return new Date(`${iso}T00:00:00.000Z`);
  }

  private toDto(h: FairnessHistoryVO): object {
    return {
      employeeId: h.employeeId,
      companyId: h.companyId,
      weekStart: h.weekStart.toISOString().split('T')[0],
      hoursWorked: h.hoursWorked,
      undesirableCount: h.undesirableCount,
      nightShiftCount: h.nightShiftCount,
      weekendCount: h.weekendCount,
      voluntaryExtraShifts: h.voluntaryExtraShifts,
    };
  }
}

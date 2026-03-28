import { ICommand } from '@nestjs/cqrs';
import type { StrategyType } from '../../domain/strategies/scheduling-strategy.interface';

/**
 * GenerateScheduleCommand
 *
 * Dispara la generación de un horario completo para una empresa y semana.
 */
export class GenerateScheduleCommand implements ICommand {
  constructor(
    public readonly companyId: string,
    /** ISO date del lunes de la semana a planificar (YYYY-MM-DD) */
    public readonly weekStart: string,
    public readonly strategyType: StrategyType,
    /** Score máximo permitido antes de bloquear turnos pesados (0–1000) */
    public readonly maxFairnessDeviation: number = 700,
    public readonly shiftTemplateId?: string,
  ) {}
}

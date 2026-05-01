import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { StrategyType } from '../../domain/strategies/scheduling-strategy.interface';
import { IsNotPastDate } from '../validators/is-not-past-date.validator';

/**
 * GenerateScheduleDto
 *
 * Valida el body de POST /schedules/generate.
 */
export class GenerateScheduleDto {
  /**
   * Fecha del lunes de la semana a planificar.
   * Formato: YYYY-MM-DD (ISO 8601 date).
   * @example "2024-03-04"
   */
  @IsDateString()
  @IsNotPastDate()
  weekStart: string;

  /**
   * Estrategia de asignación a utilizar.
   * - cost:     Minimiza costo de nómina (greedy por nivel)
   * - fairness: Distribuye carga equitativamente
   * - hybrid:   Score combinado (por defecto — recomendado producción)
   */
  @IsIn(['cost', 'fairness', 'hybrid'])
  strategy: StrategyType;

  /**
   * Puntaje máximo de fairness antes de bloquear turnos pesados.
   * Rango: 0–1000. Default: 700.
   * Configurable por empresa para ajustar sensibilidad del algoritmo.
   */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  @Type(() => Number)
  maxFairnessDeviation: number = 700;

  /**
   * Phase 14 — si está, restringe el run a empleados Y templates del
   * departamento. Sirve para que regenerar un departamento NO borre las
   * asignaciones de otros departamentos de la misma semana.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  departmentId?: string;

  /**
   * Si está, restringe el run a un único template. Combinable con
   * departmentId (debe pertenecer a ese depto).
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  shiftTemplateId?: string;
}

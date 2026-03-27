/**
 * ScheduleQualityReport — DTO de auditoría
 *
 * Generado por SchedulingEngine después de cada ejecución.
 * Se puede persistir para histórico de calidad del motor.
 */
export interface ScheduleQualityReport {
  /** Varianza de los fairness scores del equipo — menor = más equitativo */
  fairnessVariance: number;

  /** Número de asignaciones con violación de skill detectada post-hoc */
  skillViolations: number;

  /** Porcentaje de turnos cubiertos (0–100) */
  demandCoveragePercent: number;

  /** Costo proyectado de la semana (pendiente integración Payroll) */
  costProjection: number;

  /** Porcentaje de cumplimiento de restricciones legales (0–100) */
  legalComplianceScore: number;

  /** Turnos que quedaron sin cubrir */
  unfilledShiftsCount: number;

  /** Timestamp de generación */
  generatedAt: Date;

  /** Estrategia utilizada */
  strategyUsed: string;
}

/**
 * ScheduleQualityAnalyzer — Domain Service
 *
 * Calcula métricas de calidad sobre un schedule generado para auditoría.
 * Permite comparar schedules de diferentes semanas o estrategias.
 */
export class ScheduleQualityAnalyzer {
  /**
   * Determina si un schedule es "aceptable" según umbrales mínimos.
   */
  isAcceptable(report: ScheduleQualityReport): boolean {
    return (
      report.demandCoveragePercent >= 80 &&
      report.skillViolations === 0 &&
      report.legalComplianceScore === 100
    );
  }

  /**
   * Compara dos reportes y devuelve cuál es mejor.
   * Criterios (en orden): cobertura > fairness > costo.
   */
  compare(a: ScheduleQualityReport, b: ScheduleQualityReport): -1 | 0 | 1 {
    if (a.demandCoveragePercent !== b.demandCoveragePercent) {
      return a.demandCoveragePercent > b.demandCoveragePercent ? -1 : 1;
    }
    if (a.fairnessVariance !== b.fairnessVariance) {
      return a.fairnessVariance < b.fairnessVariance ? -1 : 1; // menor varianza es mejor
    }
    if (a.costProjection !== b.costProjection) {
      return a.costProjection < b.costProjection ? -1 : 1;
    }
    return 0;
  }

  /**
   * Serializa el reporte como JSON para persistencia o envío al API.
   */
  toJSON(report: ScheduleQualityReport): string {
    return JSON.stringify(
      {
        ...report,
        generatedAt: report.generatedAt.toISOString(),
      },
      null,
      2,
    );
  }
}

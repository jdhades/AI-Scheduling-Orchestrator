import { Injectable, Logger } from '@nestjs/common';
import { Incident } from '../aggregates/incident.aggregate';

export interface ShiftInfo {
  id: string;
  start_time: Date;
  end_time: Date;
  required_skills: string[];
}

export interface ReplacementResult {
  replacementEmployeeId: string;
  strategyUsed: 'internal' | 'overtime' | 'swap' | 'none';
}

@Injectable()
export class AutoRepairEngine {
  private readonly logger = new Logger(AutoRepairEngine.name);

  /**
   * Identifies shifts within the sick leave period.
   */
  detectAffectedShifts(
    employeeId: string,
    startDate: Date,
    endDate: Date,
    allCompanyShifts: ShiftInfo[], // Normally fetched from a repository
  ): string[] {
    this.logger.log(`Detecting affected shifts for Employee ${employeeId}`);

    return allCompanyShifts
      .filter((shift) => {
        // Simple overlap logic: If shift starts during the leave period
        return shift.start_time >= startDate && shift.start_time <= endDate;
      })
      .map((s) => s.id);
  }

  /**
   * Attempts to find a replacement for a broken shift using heuristic strategies.
   */
  findReplacementStrategy(
    brokenShiftId: string,
    requiredSkills: string[],
    availableEmployees: any[], // Mocks: { id, skills, currentShifts }
  ): ReplacementResult {
    this.logger.log(
      `Running Auto-Repair Heuristics for shift ${brokenShiftId}`,
    );

    // Simulation of Phase 11 Logic
    for (const emp of availableEmployees) {
      // 1. Check if employee has the required skills
      const hasSkills = requiredSkills.every((skill) =>
        emp.skills.includes(skill),
      );

      if (hasSkills) {
        // Strategy A: Internal (Available without overtime)
        // Let's assume emp.isAvailable is a pre-calculated heuristic property mapping overlapping
        if (emp.isAvailable) {
          return {
            replacementEmployeeId: emp.id,
            strategyUsed: 'internal',
          };
        }
      }
    }

    // Default fallback or prompt manager for manual intervention
    return {
      replacementEmployeeId: 'unassigned', // Will trigger a Whatsapp notification to manager
      strategyUsed: 'none',
    };
  }
}

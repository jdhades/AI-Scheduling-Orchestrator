import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { Shift, type SkillLevel } from '../../domain/aggregates/shift.aggregate';
import { ShiftAssignment } from '../../domain/aggregates/shift-assignment.aggregate';
import type { IShiftRepository } from '../../domain/repositories/shift.repository';
import { DemandWeight } from '../../domain/value-objects/demand-weight.vo';
import { UndesirableWeight } from '../../domain/value-objects/undesirable-weight.vo';
import type { StrategyType } from '../../domain/strategies/scheduling-strategy.interface';

@Injectable()
export class SupabaseShiftRepository implements IShiftRepository {
    constructor(
        @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    ) { }

    async save(shift: Shift): Promise<void> {
        const { error } = await this.supabase.from('shifts').upsert({
            id: shift.id,
            company_id: shift.companyId,
            start_time: shift.startTime.toISOString(),
            end_time: shift.endTime.toISOString(),
            required_skill_id: shift.requiredSkillId,
            required_skill_level: shift.requiredSkillLevel,
            required_experience_months: shift.requiredExperienceMonths,
            demand_score: shift.demandScore.value,
            undesirable_weight: shift.undesirableWeight.value,
        });
        if (error) throw new Error(`ShiftRepository.save failed: ${error.message}`);
    }

    async findByCompanyAndWeek(companyId: string, weekStart: Date): Promise<Shift[]> {
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 7);

        const { data, error } = await this.supabase
            .from('shifts')
            .select('*')
            .eq('company_id', companyId)
            .gte('start_time', weekStart.toISOString())
            .lt('start_time', weekEnd.toISOString());

        if (error) throw new Error(`ShiftRepository.findByCompanyAndWeek failed: ${error.message}`);
        return (data ?? []).map(row => this.toDomain(row));
    }

    async saveAssignment(assignment: ShiftAssignment): Promise<void> {
        const { error } = await this.supabase.from('shift_assignments').upsert({
            id: assignment.id,
            shift_id: assignment.shiftId,
            employee_id: assignment.employeeId,
            company_id: assignment.companyId,
            assigned_at: assignment.assignedAt.toISOString(),
            assigned_by_strategy: assignment.assignedByStrategy,
            fairness_snapshot: assignment.fairnessSnapshot,
        });
        if (error) throw new Error(`ShiftRepository.saveAssignment failed: ${error.message}`);
    }

    async findAssignmentsByEmployee(
        employeeId: string,
        companyId: string,
        from?: Date,
        to?: Date,
    ): Promise<ShiftAssignment[]> {
        let query = this.supabase
            .from('shift_assignments')
            .select('*, shifts(*)')
            .eq('employee_id', employeeId)
            .eq('company_id', companyId);

        if (from) query = query.gte('shifts.start_time', from.toISOString());
        if (to) query = query.lte('shifts.start_time', to.toISOString());

        const { data, error } = await query;
        if (error) throw new Error(`ShiftRepository.findAssignmentsByEmployee failed: ${error.message}`);
        return (data ?? []).map(row => this.assignmentToDomain(row));
    }

    async findAssignmentsByCompanyAndWeek(
        companyId: string,
        weekStart: Date,
    ): Promise<ShiftAssignment[]> {
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 7);

        const { data, error } = await this.supabase
            .from('shift_assignments')
            .select('*, shifts(*)')
            .eq('company_id', companyId)
            .gte('shifts.start_time', weekStart.toISOString())
            .lt('shifts.start_time', weekEnd.toISOString());

        if (error) throw new Error(`ShiftRepository.findAssignmentsByCompanyAndWeek failed: ${error.message}`);
        return (data ?? []).map(row => this.assignmentToDomain(row));
    }

    private toDomain(row: Record<string, any>): Shift {
        return Shift.fromPersistence({
            id: row.id,
            companyId: row.company_id,
            startTime: new Date(row.start_time),
            endTime: new Date(row.end_time),
            requiredSkillId: row.required_skill_id ?? null,
            requiredSkillLevel: (row.required_skill_level ?? 'junior') as SkillLevel,
            requiredExperienceMonths: row.required_experience_months ?? 0,
            demandScore: DemandWeight.create(row.demand_score ?? 5),
            undesirableWeight: UndesirableWeight.create(row.undesirable_weight ?? 0),
        });
    }

    private assignmentToDomain(row: Record<string, any>): ShiftAssignment {
        return ShiftAssignment.fromPersistence({
            id: row.id,
            shiftId: row.shift_id,
            employeeId: row.employee_id,
            companyId: row.company_id,
            assignedAt: new Date(row.assigned_at),
            assignedByStrategy: (row.assigned_by_strategy ?? 'hybrid') as StrategyType,
            fairnessSnapshot: row.fairness_snapshot ?? {},
        });
    }
}

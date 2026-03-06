import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { FairnessHistoryVO } from '../../domain/value-objects/fairness-history.vo';
import type { IFairnessHistoryRepository } from '../../domain/repositories/fairness-history.repository';

@Injectable()
export class SupabaseFairnessHistoryRepository implements IFairnessHistoryRepository {
    constructor(
        @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    ) { }

    async findByWeek(companyId: string, weekStart: Date): Promise<FairnessHistoryVO[]> {
        const { data, error } = await this.supabase
            .from('fairness_history')
            .select('*')
            .eq('company_id', companyId)
            .eq('week_start', weekStart.toISOString().split('T')[0]);

        if (error) throw new Error(`FairnessHistoryRepository.findByWeek failed: ${error.message}`);
        return (data ?? []).map(row => this.toDomain(row));
    }

    async findByEmployeeAndWeek(
        employeeId: string,
        companyId: string,
        weekStart: Date,
    ): Promise<FairnessHistoryVO | null> {
        const { data, error } = await this.supabase
            .from('fairness_history')
            .select('*')
            .eq('employee_id', employeeId)
            .eq('company_id', companyId)
            .eq('week_start', weekStart.toISOString().split('T')[0])
            .single();

        if (error || !data) return null;
        return this.toDomain(data);
    }

    async upsert(history: FairnessHistoryVO): Promise<void> {
        const { error } = await this.supabase.from('fairness_history').upsert(
            this.toRow(history),
            { onConflict: 'employee_id,week_start' },
        );
        if (error) throw new Error(`FairnessHistoryRepository.upsert failed: ${error.message}`);
    }

    async upsertBatch(histories: FairnessHistoryVO[]): Promise<void> {
        if (histories.length === 0) return;

        const { error } = await this.supabase.from('fairness_history').upsert(
            histories.map(h => this.toRow(h)),
            { onConflict: 'employee_id,week_start' },
        );
        if (error) throw new Error(`FairnessHistoryRepository.upsertBatch failed: ${error.message}`);
    }

    private toDomain(row: Record<string, any>): FairnessHistoryVO {
        return FairnessHistoryVO.create({
            employeeId: row.employee_id,
            companyId: row.company_id,
            weekStart: new Date(row.week_start),
            hoursWorked: row.hours_worked ?? 0,
            undesirableCount: row.undesirable_count ?? 0,
            nightShiftCount: row.night_shift_count ?? 0,
            weekendCount: row.weekend_count ?? 0,
            voluntaryExtraShifts: row.voluntary_extra_shifts ?? 0,
        });
    }

    private toRow(history: FairnessHistoryVO): Record<string, any> {
        return {
            employee_id: history.employeeId,
            company_id: history.companyId,
            week_start: history.weekStart.toISOString().split('T')[0],
            hours_worked: history.hoursWorked,
            undesirable_count: history.undesirableCount,
            night_shift_count: history.nightShiftCount,
            weekend_count: history.weekendCount,
            voluntary_extra_shifts: history.voluntaryExtraShifts,
        };
    }
}

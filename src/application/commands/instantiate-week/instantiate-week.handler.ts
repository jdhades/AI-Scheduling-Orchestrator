import { Inject, Injectable, Logger } from '@nestjs/common';
import type { IShiftTemplateRepository } from '../../../domain/repositories/shift-template.repository';
import type { IShiftRepository } from '../../../domain/repositories/shift.repository';
import { Shift } from '../../../domain/aggregates/shift.aggregate';

export interface InstantiateWeekCommand {
    companyId: string;
    weekStart: string;  // ISO date "YYYY-MM-DD" — must be a Monday
}

export interface InstantiateWeekResult {
    generated: number;
    shifts: Array<{ id: string; templateId: string | null; startTime: Date; endTime: Date }>;
}

@Injectable()
export class InstantiateWeekHandler {
    private readonly logger = new Logger(InstantiateWeekHandler.name);

    constructor(
        @Inject('SHIFT_TEMPLATE_REPOSITORY')
        private readonly templateRepo: IShiftTemplateRepository,
        @Inject('SHIFT_REPOSITORY')
        private readonly shiftRepo: IShiftRepository,
    ) { }

    async execute(command: InstantiateWeekCommand): Promise<InstantiateWeekResult> {
        const { companyId, weekStart } = command;

        // Validate that weekStart is a Monday
        const weekMondayUtc = new Date(`${weekStart}T00:00:00Z`);
        if (weekMondayUtc.getUTCDay() !== 1) {
            throw new Error(`weekStart must be a Monday. Got: ${weekStart} (weekday ${weekMondayUtc.getUTCDay()})`);
        }

        // Load all active templates
        const templates = await this.templateRepo.findAllByCompany(companyId);
        if (templates.length === 0) {
            this.logger.warn(`No active shift templates found for company ${companyId}`);
            return { generated: 0, shifts: [] };
        }

        this.logger.log(`Instantiating ${templates.length} templates for week ${weekStart}`);

        // Instantiate each template into a concrete Shift
        const newShifts: Shift[] = templates.map(t => t.instantiateForWeek(weekMondayUtc));

        // Persist all generated shifts (batch upsert via individual saves)
        // Using Promise.allSettled so one failure doesn't abort the whole batch
        const results = await Promise.allSettled(
            newShifts.map(shift => this.shiftRepo.save(shift))
        );

        const failures = results.filter(r => r.status === 'rejected');
        if (failures.length > 0) {
            this.logger.error(`${failures.length}/${newShifts.length} shifts failed to save`, failures);
        }

        const savedShifts = newShifts.filter((_, i) => results[i].status === 'fulfilled');

        this.logger.log(`✅ Instantiated ${savedShifts.length} shifts for week ${weekStart}`);

        return {
            generated: savedShifts.length,
            shifts: savedShifts.map(s => ({
                id: s.id,
                templateId: s.templateId,
                startTime: s.startTime,
                endTime: s.endTime,
            })),
        };
    }
}

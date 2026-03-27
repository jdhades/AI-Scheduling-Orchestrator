import { EventsHandler, IEventHandler, EventBus } from '@nestjs/cqrs';
import { IncidentValidatedEvent } from '../../domain/events/incident-validated.event';
import { AutoRepairEngine } from '../../domain/services/auto-repair.engine';
import { IncidentRepository } from '../../infrastructure/database/incident.repository';
import { Injectable, Logger, Inject } from '@nestjs/common';
import type { IShiftRepository } from '../../domain/repositories/shift.repository';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';

@EventsHandler(IncidentValidatedEvent)
export class IncidentValidatedHandler implements IEventHandler<IncidentValidatedEvent> {
  private readonly logger = new Logger(IncidentValidatedHandler.name);

  constructor(
    private readonly autoRepairEngine: AutoRepairEngine,
    private readonly incidentRepository: IncidentRepository,
    private readonly eventBus: EventBus,
    @Inject('IShiftRepository')
    private readonly shiftRepository: IShiftRepository,
    @Inject('IEmployeeRepository')
    private readonly employeeRepository: IEmployeeRepository,
  ) {}

  async handle(event: IncidentValidatedEvent) {
    this.logger.log(`IncidentValidatedEvent handled for: ${event.incidentId}`);

    const incident = await this.incidentRepository.findById(event.incidentId);
    if (!incident) return;

    // Phase 10: Trigger Auto-Repair
    const employeeShifts = await this.shiftRepository.findByCompanyAndWeek(
      incident.companyId,
      event.payload.startDate,
    );

    // Safety check in case the mock payload object 'Shift' from 'ShiftAssignment' does not cleanly match Phase 1
    const myShifts = employeeShifts.filter((s) => {
      const assignments = s as any; // Due to differences in Supabase domain mapping
      if (assignments && Array.isArray(assignments.assignments)) {
        return assignments.assignments.some(
          (a: any) => a.employeeId === event.employeeId,
        );
      }
      return false;
    });

    const affectedShiftsCount = this.autoRepairEngine.detectAffectedShifts(
      event.employeeId,
      event.payload.startDate,
      event.payload.endDate,
      myShifts as any,
    );

    incident.startRepair(affectedShiftsCount);

    // Phase 11: Execute Replacement Strategies
    if (affectedShiftsCount.length > 0) {
      // Querying actual available colleagues in the same company
      const availableColleagues =
        await this.employeeRepository.findAllByCompany(incident.companyId);

      for (const shiftId of affectedShiftsCount) {
        const replacement = this.autoRepairEngine.findReplacementStrategy(
          shiftId,
          ['cashier'], // Mocking skills resolution for strategy
          availableColleagues,
        );

        if (replacement.strategyUsed !== 'none') {
          incident.assignReplacement(
            replacement.replacementEmployeeId,
            shiftId,
            replacement.strategyUsed,
          );
        }
      }
    }

    // Resolve incident if all replacements mapped (Simulating full resolution)
    if (incident.status === 'replacement_assigned') {
      incident.resolveIncident(
        'Auto-Repair assigned all replacements internaly.',
      );
    }

    await this.incidentRepository.save(incident);

    // Propagate Domain Events (IncidentRepairStarted, ReplacementAssigned, IncidentResolved)
    for (const e of incident.getUncommittedEvents()) {
      this.eventBus.publish(e);
    }
    incident.commit();
  }
}

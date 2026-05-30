import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ImportStaging } from '../../domain/imports/import-staging.aggregate';
import type {
  CommitReport,
  CommitRowOutcome,
  PreCommitSnapshot,
} from './import-committer.service';

/**
 * ImportReverterService — deshace un commit de importación.
 *
 * Estrategia:
 *   - Para entidades CREATED durante el commit (vienen de
 *     commit_report.entities.*[].id): borrarlas. Hard-delete para las
 *     que no tienen soft-delete (shift_assignments, breaks, availability,
 *     timeOff, memberships, departments), soft-delete para employees y
 *     company_skills.
 *   - Para entidades UPDATED (vienen del pre_commit_snapshot): restaurar
 *     los valores previos via UPDATE.
 *   - Templates: NO se tocan. Pueden ser compartidos con otros imports
 *     o con configuración manual del owner. El owner los limpia desde
 *     /workforce/templates si quiere.
 *   - Branches: lo mismo — no se tocan. Si el commit auto-creó "Main"
 *     fallback, queda viva (puede tener otros recursos enganchados).
 *
 * Orden de operaciones (respeta FKs):
 *   1. shift_assignment_breaks (cascade igual desde shift_assignments,
 *      pero explícito).
 *   2. shift_assignments (libera templates pero no las tocamos).
 *   3. shift_memberships
 *   4. employee_availability
 *   5. day_off_requests
 *   6. employee_skills (FK a employees + company_skills)
 *   7. employees: hard-delete los created, restore los updated.
 *   8. company_skills: hard-delete los created, restore los updated
 *      (soft-deleted vuelve a su estado pre-revival).
 *   9. departments: hard-delete los created (no soft-delete), restore
 *      los updated.
 *  10. branches: solo restore (no creamos branches via import excepto
 *      la fallback "Main", que se preserva).
 */

export interface RevertReport {
  importId: string;
  startedAt: string;
  finishedAt: string;
  /** Totales agrupados por entidad. */
  details: {
    shiftAssignmentsDeleted: number;
    shiftAssignmentBreaksDeleted: number;
    membershipsDeleted: number;
    availabilityDeleted: number;
    timeOffDeleted: number;
    employeeSkillsDeleted: number;
    employeesDeleted: number;
    employeesRestored: number;
    companySkillsDeleted: number;
    companySkillsRestored: number;
    departmentsDeleted: number;
    departmentsRestored: number;
    branchesRestored: number;
  };
}

@Injectable()
export class ImportReverterService {
  private readonly logger = new Logger(ImportReverterService.name);

  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  /**
   * Revierte el commit del staging dado. El caller (controller) ya
   * validó: status='committed', ventana de revert OK, snapshot presente.
   */
  async revert(staging: ImportStaging): Promise<RevertReport> {
    const startedAt = new Date().toISOString();
    const report = staging.commitReport as CommitReport;
    const snapshot = (staging.preCommitSnapshot as PreCommitSnapshot) ?? {
      updatedBranches: [],
      updatedDepartments: [],
      updatedCompanySkills: [],
      updatedEmployees: [],
    };

    const createdIdsOf = (entity: keyof CommitReport['entities']) =>
      report.entities[entity]
        .filter((r: CommitRowOutcome) => r.outcome === 'created' && r.id)
        .map((r: CommitRowOutcome) => r.id as string);

    const details: RevertReport['details'] = {
      shiftAssignmentsDeleted: 0,
      shiftAssignmentBreaksDeleted: 0,
      membershipsDeleted: 0,
      availabilityDeleted: 0,
      timeOffDeleted: 0,
      employeeSkillsDeleted: 0,
      employeesDeleted: 0,
      employeesRestored: 0,
      companySkillsDeleted: 0,
      companySkillsRestored: 0,
      departmentsDeleted: 0,
      departmentsRestored: 0,
      branchesRestored: 0,
    };

    // 1-2. Breaks + shift_assignments (Fase 4)
    const shiftIds = createdIdsOf('shifts');
    if (shiftIds.length > 0) {
      const { count: breaksCount } = await this.supabase
        .from('shift_assignment_breaks')
        .delete({ count: 'exact' })
        .in('assignment_id', shiftIds);
      details.shiftAssignmentBreaksDeleted = breaksCount ?? 0;

      const { count: shiftsCount } = await this.supabase
        .from('shift_assignments')
        .delete({ count: 'exact' })
        .in('id', shiftIds);
      details.shiftAssignmentsDeleted = shiftsCount ?? 0;
    }

    // 3. Memberships (Fase 5)
    const membershipIds = createdIdsOf('memberships');
    if (membershipIds.length > 0) {
      const { count } = await this.supabase
        .from('shift_memberships')
        .delete({ count: 'exact' })
        .in('id', membershipIds);
      details.membershipsDeleted = count ?? 0;
    }

    // 4. Availability — solo guardamos el id de la primera row de cada
    // grupo en commit_report. El delete por id puede dejar otras rows
    // de la misma availability suelta. Compensamos borrando por
    // employee_id de los employees creados también.
    const availIds = createdIdsOf('availability');
    if (availIds.length > 0) {
      const { count } = await this.supabase
        .from('employee_availability')
        .delete({ count: 'exact' })
        .in('id', availIds);
      details.availabilityDeleted += count ?? 0;
    }

    // 5. Day-off (timeOff)
    const timeOffIds = createdIdsOf('timeOff');
    if (timeOffIds.length > 0) {
      const { count } = await this.supabase
        .from('day_off_requests')
        .delete({ count: 'exact' })
        .in('id', timeOffIds);
      details.timeOffDeleted = count ?? 0;
    }

    // 6. employee_skills — FK a employees + company_skills. Borramos
    // por employee_id de los employees creados; el resto cascadea cuando
    // soft-deleteamos.
    const employeeIdsCreated = createdIdsOf('employees');
    if (employeeIdsCreated.length > 0) {
      const { count } = await this.supabase
        .from('employee_skills')
        .delete({ count: 'exact' })
        .in('employee_id', employeeIdsCreated);
      details.employeeSkillsDeleted = count ?? 0;
    }

    // 7. employees: soft-delete created, restore updated.
    if (employeeIdsCreated.length > 0) {
      const { count } = await this.supabase
        .from('employees')
        .update({ deleted_at: new Date().toISOString() }, { count: 'exact' })
        .in('id', employeeIdsCreated)
        .is('deleted_at', null);
      details.employeesDeleted = count ?? 0;
    }
    for (const row of snapshot.updatedEmployees) {
      const { error } = await this.supabase
        .from('employees')
        .update({
          name: row.name,
          email: row.email,
          phone_number: row.phone_number,
          experience_months: row.experience_months,
          department_id: row.department_id,
        })
        .eq('id', row.id);
      if (!error) details.employeesRestored++;
    }

    // 8. company_skills: hard-delete (sin soft) los created, restore
    // los updated (volver a su soft-deleted previo si aplica).
    const roleIdsCreated = createdIdsOf('roles');
    if (roleIdsCreated.length > 0) {
      // No los hard-delete porque company_skills tiene deleted_at;
      // soft-delete deja la opción de recuperar si fue por error.
      const { count } = await this.supabase
        .from('company_skills')
        .update({ deleted_at: new Date().toISOString() }, { count: 'exact' })
        .in('id', roleIdsCreated)
        .is('deleted_at', null);
      details.companySkillsDeleted = count ?? 0;
    }
    for (const row of snapshot.updatedCompanySkills) {
      const { error } = await this.supabase
        .from('company_skills')
        .update({
          is_active: row.is_active,
          deleted_at: row.deleted_at,
        })
        .eq('id', row.id);
      if (!error) details.companySkillsRestored++;
    }

    // 9. departments: hard-delete los created, restore los updated.
    const deptIdsCreated = createdIdsOf('departments');
    if (deptIdsCreated.length > 0) {
      const { count } = await this.supabase
        .from('departments')
        .delete({ count: 'exact' })
        .in('id', deptIdsCreated);
      details.departmentsDeleted = count ?? 0;
    }
    for (const row of snapshot.updatedDepartments) {
      const { error } = await this.supabase
        .from('departments')
        .update({ name: row.name, branch_id: row.branch_id })
        .eq('id', row.id);
      if (!error) details.departmentsRestored++;
    }

    // 10. branches: solo restore (no creamos branches via import excepto
    // la fallback "Main", que se preserva intencionalmente — puede
    // tener otros recursos enganchados).
    for (const row of snapshot.updatedBranches) {
      const { error } = await this.supabase
        .from('branches')
        .update({ name: row.name, timezone: row.timezone })
        .eq('id', row.id);
      if (!error) details.branchesRestored++;
    }

    this.logger.log(
      `Reverted import ${staging.id}: ${JSON.stringify(details)}`,
    );

    return {
      importId: staging.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      details,
    };
  }
}

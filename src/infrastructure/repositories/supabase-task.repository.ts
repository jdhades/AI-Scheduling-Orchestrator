import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Task, type TaskTarget } from '../../domain/aggregates/task.aggregate';
import type { ITaskRepository } from '../../domain/repositories/task.repository';

interface TaskRow {
  id: string;
  company_id: string;
  title: string;
  description: string | null;
  is_done: boolean;
  department_id: string | null;
  employee_id: string | null;
  shift_assignment_id: string | null;
  completed_at: string | null;
  completed_by_employee_id: string | null;
  created_at: string;
}

@Injectable()
export class SupabaseTaskRepository implements ITaskRepository {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async save(task: Task): Promise<void> {
    // Mapping target → 3 cols nullable. CHECK constraint del DB
    // valida que exactamente uno está set.
    const { error } = await this.supabase.from('tasks').upsert({
      id: task.id,
      company_id: task.companyId,
      title: task.title,
      description: task.description,
      is_done: task.isDone,
      department_id:
        task.target.type === 'department' ? task.target.departmentId : null,
      employee_id:
        task.target.type === 'employee' ? task.target.employeeId : null,
      shift_assignment_id:
        task.target.type === 'assignment'
          ? task.target.shiftAssignmentId
          : null,
      completed_at: task.completedAt?.toISOString() ?? null,
      completed_by_employee_id: task.completedByEmployeeId,
    });
    if (error) throw new Error(`TaskRepository.save: ${error.message}`);
  }

  async deleteById(id: string, companyId: string): Promise<void> {
    const { error } = await this.supabase
      .from('tasks')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId);
    if (error) throw new Error(`TaskRepository.deleteById: ${error.message}`);
  }

  async findById(id: string, companyId: string): Promise<Task | null> {
    const { data, error } = await this.supabase
      .from('tasks')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();
    if (error) throw new Error(`TaskRepository.findById: ${error.message}`);
    return data ? this.rowToAggregate(data as TaskRow) : null;
  }

  async findByCompany(
    companyId: string,
    filters?: { isDone?: boolean },
  ): Promise<Task[]> {
    let q = this.supabase
      .from('tasks')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });
    if (filters?.isDone !== undefined) q = q.eq('is_done', filters.isDone);
    const { data, error } = await q;
    if (error) throw new Error(`TaskRepository.findByCompany: ${error.message}`);
    return (data ?? []).map((r) => this.rowToAggregate(r as TaskRow));
  }

  async findByDepartmentId(
    departmentId: string,
    companyId: string,
    filters?: { isDone?: boolean },
  ): Promise<Task[]> {
    let q = this.supabase
      .from('tasks')
      .select('*')
      .eq('company_id', companyId)
      .eq('department_id', departmentId)
      .order('created_at', { ascending: false });
    if (filters?.isDone !== undefined) q = q.eq('is_done', filters.isDone);
    const { data, error } = await q;
    if (error)
      throw new Error(`TaskRepository.findByDepartmentId: ${error.message}`);
    return (data ?? []).map((r) => this.rowToAggregate(r as TaskRow));
  }

  async findByEmployeeId(
    employeeId: string,
    companyId: string,
    filters?: { isDone?: boolean },
  ): Promise<Task[]> {
    let q = this.supabase
      .from('tasks')
      .select('*')
      .eq('company_id', companyId)
      .eq('employee_id', employeeId)
      .order('created_at', { ascending: false });
    if (filters?.isDone !== undefined) q = q.eq('is_done', filters.isDone);
    const { data, error } = await q;
    if (error)
      throw new Error(`TaskRepository.findByEmployeeId: ${error.message}`);
    return (data ?? []).map((r) => this.rowToAggregate(r as TaskRow));
  }

  async findByShiftAssignmentId(
    shiftAssignmentId: string,
    companyId: string,
  ): Promise<Task[]> {
    const { data, error } = await this.supabase
      .from('tasks')
      .select('*')
      .eq('company_id', companyId)
      .eq('shift_assignment_id', shiftAssignmentId)
      .order('created_at', { ascending: true });
    if (error)
      throw new Error(
        `TaskRepository.findByShiftAssignmentId: ${error.message}`,
      );
    return (data ?? []).map((r) => this.rowToAggregate(r as TaskRow));
  }

  async findByShiftAssignmentIds(
    shiftAssignmentIds: string[],
    companyId: string,
  ): Promise<Task[]> {
    if (shiftAssignmentIds.length === 0) return [];
    const { data, error } = await this.supabase
      .from('tasks')
      .select('*')
      .eq('company_id', companyId)
      .in('shift_assignment_id', shiftAssignmentIds)
      .order('created_at', { ascending: true });
    if (error)
      throw new Error(
        `TaskRepository.findByShiftAssignmentIds: ${error.message}`,
      );
    return (data ?? []).map((r) => this.rowToAggregate(r as TaskRow));
  }

  private rowToAggregate(r: TaskRow): Task {
    // Reconstruir target desde las 3 cols nullable. DB CHECK garantiza
    // que exactamente una está set.
    let target: TaskTarget;
    if (r.department_id) {
      target = { type: 'department', departmentId: r.department_id };
    } else if (r.employee_id) {
      target = { type: 'employee', employeeId: r.employee_id };
    } else if (r.shift_assignment_id) {
      target = { type: 'assignment', shiftAssignmentId: r.shift_assignment_id };
    } else {
      // Defensive — DB CHECK debería prevenir esto, pero si pasa
      // (ej. migration manual), fallar loud.
      throw new Error(
        `Task ${r.id} has no target — DB CHECK constraint violated`,
      );
    }
    return Task.fromPersistence({
      id: r.id,
      companyId: r.company_id,
      title: r.title,
      description: r.description,
      isDone: r.is_done,
      target,
      completedAt: r.completed_at ? new Date(r.completed_at) : null,
      completedByEmployeeId: r.completed_by_employee_id,
      createdAt: new Date(r.created_at),
    });
  }
}

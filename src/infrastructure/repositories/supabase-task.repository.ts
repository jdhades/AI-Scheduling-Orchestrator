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
  shift_template_id: string | null;
  employee_id: string | null;
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
    // Mapping target → 2 cols nullable. CHECK constraint del DB
    // valida que exactamente uno está set.
    const { error } = await this.supabase.from('tasks').upsert({
      id: task.id,
      company_id: task.companyId,
      title: task.title,
      description: task.description,
      is_done: task.isDone,
      shift_template_id:
        task.target.type === 'template' ? task.target.shiftTemplateId : null,
      employee_id:
        task.target.type === 'employee' ? task.target.employeeId : null,
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
    if (error)
      throw new Error(`TaskRepository.findByCompany: ${error.message}`);
    return (data ?? []).map((r) => this.rowToAggregate(r as TaskRow));
  }

  async findByTemplateId(
    templateId: string,
    companyId: string,
    filters?: { isDone?: boolean },
  ): Promise<Task[]> {
    let q = this.supabase
      .from('tasks')
      .select('*')
      .eq('company_id', companyId)
      .eq('shift_template_id', templateId)
      .order('created_at', { ascending: false });
    if (filters?.isDone !== undefined) q = q.eq('is_done', filters.isDone);
    const { data, error } = await q;
    if (error)
      throw new Error(`TaskRepository.findByTemplateId: ${error.message}`);
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

  private rowToAggregate(r: TaskRow): Task {
    // Reconstruir target desde las 2 cols nullable. DB CHECK garantiza
    // que exactamente una está set.
    let target: TaskTarget;
    if (r.shift_template_id) {
      target = { type: 'template', shiftTemplateId: r.shift_template_id };
    } else if (r.employee_id) {
      target = { type: 'employee', employeeId: r.employee_id };
    } else {
      // Defensive — DB CHECK debería prevenir esto.
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

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

// TODO(dry): ISO_DATE duplicado en varios controllers; extraer a util.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import { Requires } from '../../infrastructure/auth/decorators/requires.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';
import { Task, type TaskTarget } from '../../domain/aggregates/task.aggregate';
import {
  TASK_REPOSITORY,
  type ITaskRepository,
} from '../../domain/repositories/task.repository';
import {
  ENTITY_AUDIT_SERVICE,
  type IEntityAuditService,
  computeChangeSet,
  snapshotAsChangeSet,
} from '../../domain/audit/entity-audit.service';

// ─── DTOs ─────────────────────────────────────────────────────────────

export class CreateTaskDto {
  @IsString()
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  // Exactamente uno de los 2 debe venir. Validamos en el handler porque
  // class-validator no expresa "exactly one of" sin un custom validator.
  @IsOptional()
  @IsUUID('loose')
  shiftTemplateId?: string;

  @IsOptional()
  @IsUUID('loose')
  employeeId?: string;
}

export class UpdateTaskDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  isDone?: boolean;
}

interface TaskResponse {
  id: string;
  title: string;
  description: string | null;
  isDone: boolean;
  target:
    | { type: 'template'; shiftTemplateId: string }
    | { type: 'employee'; employeeId: string };
  completedAt: string | null;
  completedByEmployeeId: string | null;
  createdAt: string;
}

const toDto = (t: Task): TaskResponse => ({
  id: t.id,
  title: t.title,
  description: t.description,
  isDone: t.isDone,
  target: t.target,
  completedAt: t.completedAt?.toISOString() ?? null,
  completedByEmployeeId: t.completedByEmployeeId,
  createdAt: t.createdAt.toISOString(),
});

const parseIsDone = (raw?: string): boolean | undefined => {
  if (raw === undefined) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new BadRequestException('isDone must be "true" or "false"');
};

const targetFromDto = (dto: CreateTaskDto): TaskTarget => {
  const provided = [
    dto.shiftTemplateId ? 'template' : null,
    dto.employeeId ? 'employee' : null,
  ].filter(Boolean);
  if (provided.length !== 1) {
    throw new BadRequestException(
      'Must provide exactly one of: shiftTemplateId, employeeId',
    );
  }
  if (dto.shiftTemplateId) {
    return { type: 'template', shiftTemplateId: dto.shiftTemplateId };
  }
  return { type: 'employee', employeeId: dto.employeeId! };
};

export class CompleteTaskDto {
  /** Día del completado (YYYY-MM-DD, tz del empleado). */
  @Matches(ISO_DATE, { message: 'date must be YYYY-MM-DD' })
  date!: string;
}

/** Tarea del empleado para un día, con flag de hecho-hoy. */
interface TodayTaskDto {
  id: string;
  title: string;
  description: string | null;
  /** 'template' = tarea de turno (compartida) | 'employee' = personal. */
  kind: 'template' | 'employee';
  doneToday: boolean;
}

interface MyTasksTodayResponse {
  tasks: TodayTaskDto[];
  /** Enforcement del check (configurable por el manager). */
  requireOnShift: boolean;
  requireOnSite: boolean;
}

/** Estado de una tarea del día para la vista del manager. */
interface TaskStatusItem {
  id: string;
  title: string;
  kind: 'template' | 'employee';
  /** Nombre del template (turno) o del empleado dueño de la tarea. */
  targetLabel: string;
  done: boolean;
  completedByName: string | null;
  completedAt: string | null;
}

interface TasksTodayStatusResponse {
  date: string;
  doneCount: number;
  totalCount: number;
  tasks: TaskStatusItem[];
}

/**
 * TasksController
 *
 * Trees expuestos:
 *
 *   POST   /tasks                                  — crear (template | employee)
 *   GET    /tasks?isDone=                          — listado del tenant (manager)
 *   PATCH  /tasks/:id                              — title/desc/isDone
 *   DELETE /tasks/:id                              — borrar
 *
 *   GET    /shift-templates/:templateId/tasks?isDone=
 *   GET    /employees/:employeeId/tasks?isDone=
 *
 * Writes piden `schedule:write` (consistente con shift-breaks).
 *
 * Toggle a done captura `completed_by_employee_id` del caller.
 */
@Controller()
export class TasksController {
  constructor(
    @Inject(TASK_REPOSITORY) private readonly tasks: ITaskRepository,
    @Inject(ENTITY_AUDIT_SERVICE)
    private readonly audit: IEntityAuditService,
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
  ) {}

  /** Snapshot serializable usado por el audit log. */
  private auditSnapshot(t: Task): Record<string, unknown> {
    return {
      title: t.title,
      description: t.description,
      isDone: t.isDone,
      target: t.target,
      completedByEmployeeId: t.completedByEmployeeId,
    };
  }

  @Post('tasks')
  @Requires('schedule:write')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
    @Body() dto: CreateTaskDto,
  ): Promise<TaskResponse> {
    const target = targetFromDto(dto);
    const task = Task.create({
      id: randomUUID(),
      companyId,
      title: dto.title,
      description: dto.description ?? null,
      target,
    });
    await this.tasks.save(task);
    await this.audit.log({
      companyId,
      entityType: 'task',
      entityId: task.id,
      action: 'create',
      changes: snapshotAsChangeSet(this.auditSnapshot(task), 'create'),
      actorUserId: user?.userId ?? null,
      actorEmployeeId: user?.employeeId ?? null,
    });
    return toDto(task);
  }

  @Get('tasks')
  async list(
    @CurrentCompany() companyId: string,
    @Query('isDone') isDoneRaw?: string,
  ): Promise<TaskResponse[]> {
    const isDone = parseIsDone(isDoneRaw);
    const rows = await this.tasks.findByCompany(companyId, { isDone });
    return rows.map(toDto);
  }

  @Get('tasks/:id')
  async getOne(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<TaskResponse> {
    const task = await this.tasks.findById(id, companyId);
    if (!task) throw new NotFoundException(`Task ${id} not found`);
    return toDto(task);
  }

  @Patch('tasks/:id')
  @Requires('schedule:write')
  async update(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
    @Body() dto: UpdateTaskDto,
  ): Promise<TaskResponse> {
    const existing = await this.tasks.findById(id, companyId);
    if (!existing) throw new NotFoundException(`Task ${id} not found`);

    const nextTitle = dto.title ?? existing.title;
    const nextDescription =
      dto.description !== undefined ? dto.description : existing.description;

    let next: Task;
    if (dto.isDone === true && !existing.isDone) {
      const completedBy = user?.employeeId ?? null;
      const done = existing.markDone(completedBy);
      next = Task.fromPersistence({
        id: done.id,
        companyId: done.companyId,
        title: nextTitle,
        description: nextDescription,
        isDone: true,
        target: done.target,
        completedAt: done.completedAt,
        completedByEmployeeId: done.completedByEmployeeId,
        createdAt: done.createdAt,
      });
    } else if (dto.isDone === false && existing.isDone) {
      next = Task.fromPersistence({
        id: existing.id,
        companyId: existing.companyId,
        title: nextTitle,
        description: nextDescription,
        isDone: false,
        target: existing.target,
        completedAt: null,
        completedByEmployeeId: null,
        createdAt: existing.createdAt,
      });
    } else {
      next = Task.fromPersistence({
        id: existing.id,
        companyId: existing.companyId,
        title: nextTitle,
        description: nextDescription,
        isDone: existing.isDone,
        target: existing.target,
        completedAt: existing.completedAt,
        completedByEmployeeId: existing.completedByEmployeeId,
        createdAt: existing.createdAt,
      });
    }

    await this.tasks.save(next);
    const changes = computeChangeSet(
      this.auditSnapshot(existing),
      this.auditSnapshot(next),
      ['title', 'description', 'isDone', 'completedByEmployeeId'],
    );
    if (Object.keys(changes).length > 0) {
      await this.audit.log({
        companyId,
        entityType: 'task',
        entityId: id,
        action: 'update',
        changes,
        actorUserId: user?.userId ?? null,
        actorEmployeeId: user?.employeeId ?? null,
      });
    }
    return toDto(next);
  }

  @Delete('tasks/:id')
  @Requires('schedule:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
  ): Promise<void> {
    const existing = await this.tasks.findById(id, companyId);
    if (!existing) throw new NotFoundException(`Task ${id} not found`);
    await this.tasks.deleteById(id, companyId);
    await this.audit.log({
      companyId,
      entityType: 'task',
      entityId: id,
      action: 'delete',
      changes: snapshotAsChangeSet(this.auditSnapshot(existing), 'delete'),
      actorUserId: user?.userId ?? null,
      actorEmployeeId: user?.employeeId ?? null,
    });
  }

  // ─── Listados por target ────────────────────────────────────────────

  @Get('shift-templates/:templateId/tasks')
  async listByTemplate(
    @Param('templateId') templateId: string,
    @CurrentCompany() companyId: string,
    @Query('isDone') isDoneRaw?: string,
  ): Promise<TaskResponse[]> {
    const isDone = parseIsDone(isDoneRaw);
    const rows = await this.tasks.findByTemplateId(templateId, companyId, {
      isDone,
    });
    return rows.map(toDto);
  }

  @Get('employees/:employeeId/tasks')
  async listByEmployee(
    @Param('employeeId') employeeId: string,
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
    @Query('isDone') isDoneRaw?: string,
  ): Promise<TaskResponse[]> {
    // Un empleado solo puede leer sus propias tareas. Owners/managers
    // ven cualquiera del tenant.
    if (user?.role === 'employee' && user.employeeId !== employeeId) {
      throw new ForbiddenException('Employees can only read their own tasks');
    }
    const isDone = parseIsDone(isDoneRaw);
    const rows = await this.tasks.findByEmployeeId(employeeId, companyId, {
      isDone,
    });
    return rows.map(toDto);
  }

  // ─── Fase E — tareas del día (reinicio diario) ──────────────────────

  /**
   * GET /tasks/mine/today?date=YYYY-MM-DD — tareas del empleado para ese día:
   * las del/los turno(s) que cubre (target=template, compartidas) + las
   * personales, con flag `doneToday`. Incluye el modo de enforcement del check.
   */
  @Get('tasks/mine/today')
  async myTasksToday(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
    @Query('date') date?: string,
  ): Promise<MyTasksTodayResponse> {
    if (!user?.employeeId) throw new ForbiddenException('No employee linked');
    if (!date || !ISO_DATE.test(date)) {
      throw new BadRequestException('date must be YYYY-MM-DD');
    }
    const employeeId = user.employeeId;

    // Templates que el empleado cubre ese día.
    const { data: assigns } = await this.supabase
      .from('shift_assignments')
      .select('template_id')
      .eq('company_id', companyId)
      .eq('employee_id', employeeId)
      .eq('date', date);
    const templateIds = [
      ...new Set(
        ((assigns ?? []) as Array<{ template_id: string | null }>)
          .map((a) => a.template_id)
          .filter((t): t is string => !!t),
      ),
    ];

    const shiftTasks = (
      await Promise.all(
        templateIds.map((tid) => this.tasks.findByTemplateId(tid, companyId, {})),
      )
    ).flat();
    const personalTasks = await this.tasks.findByEmployeeId(employeeId, companyId, {});
    const byId = new Map<string, Task>();
    for (const t of [...shiftTasks, ...personalTasks]) byId.set(t.id, t);
    const all = [...byId.values()];

    const doneSet = new Set<string>();
    if (all.length) {
      const { data: comps } = await this.supabase
        .from('task_completions')
        .select('task_id')
        .eq('company_id', companyId)
        .eq('date', date)
        .in('task_id', all.map((t) => t.id));
      for (const c of (comps ?? []) as Array<{ task_id: string }>) {
        doneSet.add(c.task_id);
      }
    }

    const { data: company } = await this.supabase
      .from('companies')
      .select('task_check_require_on_shift, task_check_require_on_site')
      .eq('id', companyId)
      .maybeSingle<{
        task_check_require_on_shift: boolean;
        task_check_require_on_site: boolean;
      }>();

    return {
      requireOnShift: company?.task_check_require_on_shift ?? true,
      requireOnSite: company?.task_check_require_on_site ?? true,
      tasks: all.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        kind: t.target.type,
        doneToday: doneSet.has(t.id),
      })),
    };
  }

  /** POST /tasks/:id/complete — marca la tarea hecha para el día (idempotente). */
  @Post('tasks/:id/complete')
  @HttpCode(HttpStatus.NO_CONTENT)
  async complete(
    @Param('id') id: string,
    @Body() body: CompleteTaskDto,
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    if (!user?.employeeId) throw new ForbiddenException('No employee linked');
    const { error } = await this.supabase.from('task_completions').upsert(
      {
        company_id: companyId,
        task_id: id,
        date: body.date,
        completed_by_employee_id: user.employeeId,
      },
      { onConflict: 'task_id,date', ignoreDuplicates: true },
    );
    if (error) throw new BadRequestException(error.message);
  }

  /** POST /tasks/:id/uncomplete — desmarca la tarea de ese día. */
  @Post('tasks/:id/uncomplete')
  @HttpCode(HttpStatus.NO_CONTENT)
  async uncomplete(
    @Param('id') id: string,
    @Body() body: CompleteTaskDto,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    await this.supabase
      .from('task_completions')
      .delete()
      .eq('company_id', companyId)
      .eq('task_id', id)
      .eq('date', body.date);
  }

  /**
   * GET /tasks/today/status?date=YYYY-MM-DD — vista del manager: estado de
   * completado de las tareas del día. Incluye las de turno cuyos templates
   * tienen asignación ese día (turno activo) + todas las personales. Solo
   * owner/manager; el empleado usa /tasks/mine/today.
   */
  @Get('tasks/today/status')
  async todayStatus(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
    @Query('date') date?: string,
  ): Promise<TasksTodayStatusResponse> {
    if (user?.role === 'employee') {
      throw new ForbiddenException('Managers only');
    }
    if (!date || !ISO_DATE.test(date)) {
      throw new BadRequestException('date must be YYYY-MM-DD');
    }

    // Templates con asignación ese día → sus tareas de turno están "activas".
    const { data: assigns } = await this.supabase
      .from('shift_assignments')
      .select('template_id')
      .eq('company_id', companyId)
      .eq('date', date);
    const activeTemplateIds = new Set(
      ((assigns ?? []) as Array<{ template_id: string | null }>)
        .map((a) => a.template_id)
        .filter((t): t is string => !!t),
    );

    const allTasks = await this.tasks.findByCompany(companyId, {});
    const relevant = allTasks.filter(
      (t) =>
        t.target.type === 'employee' ||
        (t.target.type === 'template' &&
          activeTemplateIds.has(t.target.shiftTemplateId)),
    );

    // Completions del día → quién y cuándo.
    const compByTask = new Map<string, { by: string | null; at: string }>();
    if (relevant.length) {
      const { data: comps } = await this.supabase
        .from('task_completions')
        .select('task_id, completed_by_employee_id, completed_at')
        .eq('company_id', companyId)
        .eq('date', date)
        .in(
          'task_id',
          relevant.map((t) => t.id),
        );
      for (const c of (comps ?? []) as Array<{
        task_id: string;
        completed_by_employee_id: string | null;
        completed_at: string;
      }>) {
        compByTask.set(c.task_id, {
          by: c.completed_by_employee_id,
          at: c.completed_at,
        });
      }
    }

    // Resolver nombres: templates (label) + empleados (target personal + quién completó).
    const templateIds = [
      ...new Set(
        relevant.flatMap((t) =>
          t.target.type === 'template' ? [t.target.shiftTemplateId] : [],
        ),
      ),
    ];
    const employeeIds = [
      ...new Set([
        ...relevant.flatMap((t) =>
          t.target.type === 'employee' ? [t.target.employeeId] : [],
        ),
        ...[...compByTask.values()]
          .map((c) => c.by)
          .filter((id): id is string => !!id),
      ]),
    ];

    const tplName = new Map<string, string>();
    if (templateIds.length) {
      const { data } = await this.supabase
        .from('shift_templates')
        .select('id, name')
        .in('id', templateIds);
      for (const r of (data ?? []) as Array<{ id: string; name: string }>) {
        tplName.set(r.id, r.name);
      }
    }
    const empName = new Map<string, string>();
    if (employeeIds.length) {
      const { data } = await this.supabase
        .from('employees')
        .select('id, name')
        .in('id', employeeIds);
      for (const r of (data ?? []) as Array<{ id: string; name: string }>) {
        empName.set(r.id, r.name);
      }
    }

    const items: TaskStatusItem[] = relevant.map((t) => {
      const comp = compByTask.get(t.id);
      const targetLabel =
        t.target.type === 'template'
          ? (tplName.get(t.target.shiftTemplateId) ?? '—')
          : (empName.get(t.target.employeeId) ?? '—');
      return {
        id: t.id,
        title: t.title,
        kind: t.target.type,
        targetLabel,
        done: !!comp,
        completedByName: comp?.by ? (empName.get(comp.by) ?? null) : null,
        completedAt: comp?.at ?? null,
      };
    });
    // Pendientes primero; dentro de cada grupo, por nombre.
    items.sort((a, b) =>
      a.done === b.done
        ? a.targetLabel.localeCompare(b.targetLabel)
        : a.done
          ? 1
          : -1,
    );

    return {
      date,
      doneCount: items.filter((i) => i.done).length,
      totalCount: items.length,
      tasks: items,
    };
  }
}

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
  MaxLength,
} from 'class-validator';
import { randomUUID } from 'crypto';
import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import { Requires } from '../../infrastructure/auth/decorators/requires.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';
import { Task, type TaskTarget } from '../../domain/aggregates/task.aggregate';
import {
  TASK_REPOSITORY,
  type ITaskRepository,
} from '../../domain/repositories/task.repository';

// ─── DTOs ─────────────────────────────────────────────────────────────

export class CreateTaskDto {
  @IsString()
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  // Exactamente uno de los 3 debe venir. Validamos en el handler porque
  // class-validator no expresa "exactly one of" sin un custom validator.
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @IsOptional()
  @IsUUID()
  shiftAssignmentId?: string;
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
    | { type: 'department'; departmentId: string }
    | { type: 'employee'; employeeId: string }
    | { type: 'assignment'; shiftAssignmentId: string };
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
    dto.departmentId ? 'department' : null,
    dto.employeeId ? 'employee' : null,
    dto.shiftAssignmentId ? 'assignment' : null,
  ].filter(Boolean);
  if (provided.length !== 1) {
    throw new BadRequestException(
      'Must provide exactly one of: departmentId, employeeId, shiftAssignmentId',
    );
  }
  if (dto.departmentId) {
    return { type: 'department', departmentId: dto.departmentId };
  }
  if (dto.employeeId) {
    return { type: 'employee', employeeId: dto.employeeId };
  }
  return { type: 'assignment', shiftAssignmentId: dto.shiftAssignmentId! };
};

/**
 * TasksController
 *
 * Trees expuestos:
 *
 *   POST   /tasks                                       — crear (uno de 3 targets)
 *   GET    /tasks?isDone=                               — listado del tenant (manager)
 *   PATCH  /tasks/:id                                   — title/desc/isDone
 *   DELETE /tasks/:id                                   — borrar
 *
 *   GET    /departments/:departmentId/tasks?isDone=
 *   GET    /employees/:employeeId/tasks?isDone=
 *   GET    /shift-assignments/:assignmentId/tasks
 *
 * Writes piden `schedule:write` (consistente con shift-breaks — tareas
 * de turno son parte del flujo de scheduling). Reads pasan con cualquier
 * autenticación válida.
 *
 * Toggle a done captura `completed_by_employee_id` del caller (req.auth.employeeId).
 * En path DEV_AUTH_BYPASS el employeeId queda null → se acepta (audit
 * pendiente hasta que el JWT real esté en prod).
 */
@Controller()
export class TasksController {
  constructor(
    @Inject(TASK_REPOSITORY) private readonly tasks: ITaskRepository,
  ) {}

  @Post('tasks')
  @Requires('schedule:write')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentCompany() companyId: string,
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

    // Rebuild aggregate con los nuevos campos. markDone() valida la
    // transición y setea completedAt automáticamente.
    const nextTitle = dto.title ?? existing.title;
    const nextDescription =
      dto.description !== undefined ? dto.description : existing.description;

    if (dto.isDone === true && !existing.isDone) {
      const completedBy = user?.employeeId ?? null;
      const done = existing.markDone(completedBy);
      const updated = Task.fromPersistence({
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
      await this.tasks.save(updated);
      return toDto(updated);
    }

    if (dto.isDone === false && existing.isDone) {
      // Reopen — limpiamos completedAt + completedBy.
      const reopened = Task.fromPersistence({
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
      await this.tasks.save(reopened);
      return toDto(reopened);
    }

    // Solo edita texto — preserva estado done/createdAt.
    const edited = Task.fromPersistence({
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
    await this.tasks.save(edited);
    return toDto(edited);
  }

  @Delete('tasks/:id')
  @Requires('schedule:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    const existing = await this.tasks.findById(id, companyId);
    if (!existing) throw new NotFoundException(`Task ${id} not found`);
    await this.tasks.deleteById(id, companyId);
  }

  // ─── Listados por target ────────────────────────────────────────────

  @Get('departments/:departmentId/tasks')
  async listByDepartment(
    @Param('departmentId') departmentId: string,
    @CurrentCompany() companyId: string,
    @Query('isDone') isDoneRaw?: string,
  ): Promise<TaskResponse[]> {
    const isDone = parseIsDone(isDoneRaw);
    const rows = await this.tasks.findByDepartmentId(
      departmentId,
      companyId,
      { isDone },
    );
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
    // ven cualquiera del tenant (scope check via dept queda como
    // follow-up — el repo ya filtra por company_id vía RLS).
    if (user?.role === 'employee' && user.employeeId !== employeeId) {
      throw new ForbiddenException(
        'Employees can only read their own tasks',
      );
    }
    const isDone = parseIsDone(isDoneRaw);
    const rows = await this.tasks.findByEmployeeId(
      employeeId,
      companyId,
      { isDone },
    );
    return rows.map(toDto);
  }

  @Get('shift-assignments/:assignmentId/tasks')
  async listByShiftAssignment(
    @Param('assignmentId') assignmentId: string,
    @CurrentCompany() companyId: string,
  ): Promise<TaskResponse[]> {
    const rows = await this.tasks.findByShiftAssignmentId(
      assignmentId,
      companyId,
    );
    return rows.map(toDto);
  }
}

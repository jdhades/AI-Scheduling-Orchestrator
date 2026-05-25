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
}

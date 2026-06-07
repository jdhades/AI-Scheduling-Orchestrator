import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import { Requires } from '../../infrastructure/auth/decorators/requires.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';
import {
  ENTITY_AUDIT_SERVICE,
  computeChangeSet,
  snapshotAsChangeSet,
  type IEntityAuditService,
} from '../../domain/audit/entity-audit.service';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { randomUUID } from 'crypto';
import type {
  IShiftTemplateRepository,
  ShiftTemplatePatch,
} from '../../domain/repositories/shift-template.repository';
import { ShiftTemplate } from '../../domain/aggregates/shift-template.aggregate';
import { DemandWeight } from '../../domain/value-objects/demand-weight.vo';
import { UndesirableWeight } from '../../domain/value-objects/undesirable-weight.vo';

// ─── DTOs ─────────────────────────────────────────────────────────────────────

// HH:MM en 24h. Acepta también HH:MM:SS (varias bocas del backend lo
// devuelven con segundos; class-validator lo deja entrar igual).
const TIME_HHMM = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

export class CreateShiftTemplateDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  /** 0=Dom … 6=Sáb · null = aplica a todos los días. */
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number | null;

  @Matches(TIME_HHMM, { message: 'startTime must be HH:MM (24h)' })
  startTime!: string;

  @Matches(TIME_HHMM, { message: 'endTime must be HH:MM (24h)' })
  endTime!: string;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @IsNotEmpty()
  requiredSkillId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  demandScore?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  undesirableWeight?: number;

  /** null = ELASTIC slot (absorbe sobrante). */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  requiredEmployees?: number | null;

  /** UUID del departamento al que pertenece el template. null = company-wide. */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @IsNotEmpty()
  departmentId?: string | null;

  /** UUID de la locación (feature 'locations'). null = sin locación. */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @IsNotEmpty()
  locationId?: string | null;
}

export class UpdateShiftTemplateDto implements ShiftTemplatePatch {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek?: number | null;

  @IsOptional()
  @Matches(TIME_HHMM, { message: 'startTime must be HH:MM (24h)' })
  startTime?: string;

  @IsOptional()
  @Matches(TIME_HHMM, { message: 'endTime must be HH:MM (24h)' })
  endTime?: string;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @IsNotEmpty()
  requiredSkillId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  demandScore?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  undesirableWeight?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  requiredEmployees?: number | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @IsNotEmpty()
  departmentId?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @IsNotEmpty()
  locationId?: string | null;
}

// ─── Controller ───────────────────────────────────────────────────────────────

/**
 * ShiftTemplatesController
 *
 * GET    /shift-templates                 — list active templates for company
 * POST   /shift-templates                 — create a new template
 * DELETE /shift-templates/:id             — remove a template
 *
 * NOTE: el endpoint POST /shift-templates/instantiate fue eliminado en el
 * rework del modelo de shifts (instancias virtuales generadas en runtime).
 */
@Controller('shift-templates')
export class ShiftTemplatesController {
  private readonly logger = new Logger(ShiftTemplatesController.name);

  constructor(
    @Inject('SHIFT_TEMPLATE_REPOSITORY')
    private readonly templateRepo: IShiftTemplateRepository,
    @Inject(ENTITY_AUDIT_SERVICE)
    private readonly audit: IEntityAuditService,
  ) {}

  private auditSnapshot(t: ShiftTemplate): {
    name: string;
    dayOfWeek: number | null;
    startTime: string;
    endTime: string;
    requiredSkillId: string | null;
    demandScore: number;
    undesirableWeight: number;
    isActive: boolean;
    requiredEmployees: number | null;
    departmentId: string | null;
  } {
    return {
      name: t.name,
      dayOfWeek: t.dayOfWeek,
      startTime: t.startTime,
      endTime: t.endTime,
      requiredSkillId: t.requiredSkillId,
      demandScore: t.demandScore.value,
      undesirableWeight: t.undesirableWeight.value,
      isActive: t.isActive,
      requiredEmployees: t.requiredEmployees,
      departmentId: t.departmentId,
    };
  }

  /**
   * GET /shift-templates?companyId=...
   * Returns all active templates for the company, sorted by day + time.
   */
  @Get()
  async list(@CurrentCompany() companyId: string): Promise<object[]> {
    const templates = await this.templateRepo.findAllByCompany(companyId);
    return templates.map(this.toDto);
  }

  /**
   * POST /shift-templates?companyId=...
   * Creates a new shift template.
   */
  @Post()
  @Requires('schedule:write')
  async create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
    @Body() dto: CreateShiftTemplateDto,
  ): Promise<object> {
    const template = ShiftTemplate.create({
      id: randomUUID(),
      companyId,
      name: dto.name,
      // El aggregate declara dayOfWeek: number, pero acepta null en runtime
      // (los checks usan < / > que con null coercen a 0). Mantener
      // null para "todos los días" requeriría cambiar la firma del
      // aggregate; lo dejamos pendiente y casteamos acá.
      dayOfWeek: dto.dayOfWeek as number,
      startTime: dto.startTime,
      endTime: dto.endTime,
      requiredSkillId: dto.requiredSkillId ?? null,
      requiredSkillLevel: 'junior',
      requiredExperienceMonths: 0,
      demandScore: DemandWeight.create(dto.demandScore ?? 1),
      undesirableWeight: UndesirableWeight.create(dto.undesirableWeight ?? 0),
      isActive: true,
      requiredEmployees: dto.requiredEmployees ?? null,
      departmentId: dto.departmentId ?? null,
      locationId: dto.locationId ?? null,
    });

    await this.templateRepo.save(template);
    await this.audit.log({
      companyId,
      entityType: 'shift_template',
      entityId: template.id,
      action: 'create',
      changes: snapshotAsChangeSet(this.auditSnapshot(template), 'create'),
      actorUserId: user?.userId ?? null,
      actorEmployeeId: user?.employeeId ?? null,
    });
    return this.toDto(template);
  }

  /**
   * GET /shift-templates/:id?companyId=...
   */
  @Get(':id')
  async getById(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<object> {
    const t = await this.templateRepo.findById(id, companyId);
    if (!t) throw new NotFoundException(`ShiftTemplate ${id} not found`);
    return this.toDto(t);
  }

  /**
   * PATCH /shift-templates/:id?companyId=...
   * Partial update. Omitted fields stay; `null` en nullable = clear.
   */
  @Patch(':id')
  @Requires('schedule:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async update(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
    @Body() dto: UpdateShiftTemplateDto,
  ): Promise<void> {
    const existing = await this.templateRepo.findById(id, companyId);
    if (!existing) throw new NotFoundException(`ShiftTemplate ${id} not found`);
    await this.templateRepo.updatePartial(id, companyId, dto);
    const after = await this.templateRepo.findById(id, companyId);
    if (after) {
      const fields = [
        'name',
        'dayOfWeek',
        'startTime',
        'endTime',
        'requiredSkillId',
        'demandScore',
        'undesirableWeight',
        'isActive',
        'requiredEmployees',
        'departmentId',
      ] as const;
      await this.audit.log({
        companyId,
        entityType: 'shift_template',
        entityId: id,
        action: 'update',
        changes: computeChangeSet(
          this.auditSnapshot(existing),
          this.auditSnapshot(after),
          fields,
        ),
        actorUserId: user?.userId ?? null,
        actorEmployeeId: user?.employeeId ?? null,
      });
    }
  }

  /**
   * DELETE /shift-templates/:id?companyId=...
   * Soft delete — is_active=false + deleted_at=NOW(). Assignments ya
   * generados quedan intactos.
   */
  @Delete(':id')
  @Requires('schedule:write')
  async remove(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
  ): Promise<{ success: boolean }> {
    const existing = await this.templateRepo.findById(id, companyId);
    await this.templateRepo.delete(id, companyId);
    if (existing) {
      await this.audit.log({
        companyId,
        entityType: 'shift_template',
        entityId: id,
        action: 'delete',
        changes: snapshotAsChangeSet(this.auditSnapshot(existing), 'delete'),
        actorUserId: user?.userId ?? null,
        actorEmployeeId: user?.employeeId ?? null,
      });
    }
    return { success: true };
  }

  private toDto(t: ShiftTemplate): object {
    return {
      id: t.id,
      name: t.name,
      dayOfWeek: t.dayOfWeek,
      startTime: t.startTime,
      endTime: t.endTime,
      requiredSkillId: t.requiredSkillId,
      demandScore: t.demandScore.value,
      undesirableWeight: t.undesirableWeight.value,
      isActive: t.isActive,
      requiredEmployees: t.requiredEmployees,
      departmentId: t.departmentId,
      locationId: t.locationId,
    };
  }
}

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
import { randomUUID } from 'crypto';
import type {
  IShiftTemplateRepository,
  ShiftTemplatePatch,
} from '../../domain/repositories/shift-template.repository';
import { ShiftTemplate } from '../../domain/aggregates/shift-template.aggregate';
import { DemandWeight } from '../../domain/value-objects/demand-weight.vo';
import { UndesirableWeight } from '../../domain/value-objects/undesirable-weight.vo';
// ─── DTOs ─────────────────────────────────────────────────────────────────────

export class CreateShiftTemplateDto {
  name: string;
  dayOfWeek: number; // 0=Sun … 6=Sat
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
  requiredSkillId?: string | null;
  demandScore?: number;
  undesirableWeight?: number;
  requiredEmployees?: number | null;
}

export class UpdateShiftTemplateDto implements ShiftTemplatePatch {
  name?: string;
  dayOfWeek?: number | null;
  startTime?: string;
  endTime?: string;
  requiredSkillId?: string | null;
  demandScore?: number;
  undesirableWeight?: number;
  isActive?: boolean;
  requiredEmployees?: number | null;
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
  ) {}

  /**
   * GET /shift-templates?companyId=...
   * Returns all active templates for the company, sorted by day + time.
   */
  @Get()
  async list(@Query('companyId') companyId: string): Promise<object[]> {
    const templates = await this.templateRepo.findAllByCompany(companyId);
    return templates.map(this.toDto);
  }

  /**
   * POST /shift-templates?companyId=...
   * Creates a new shift template.
   */
  @Post()
  async create(
    @Query('companyId') companyId: string,
    @Body() dto: CreateShiftTemplateDto,
  ): Promise<object> {
    const template = ShiftTemplate.create({
      id: randomUUID(),
      companyId,
      name: dto.name,
      dayOfWeek: dto.dayOfWeek,
      startTime: dto.startTime,
      endTime: dto.endTime,
      requiredSkillId: dto.requiredSkillId ?? null,
      requiredSkillLevel: 'junior',
      requiredExperienceMonths: 0,
      demandScore: DemandWeight.create(dto.demandScore ?? 1),
      undesirableWeight: UndesirableWeight.create(dto.undesirableWeight ?? 0),
      isActive: true,
      requiredEmployees: dto.requiredEmployees ?? null,
    });

    await this.templateRepo.save(template);
    return this.toDto(template);
  }

  /**
   * GET /shift-templates/:id?companyId=...
   */
  @Get(':id')
  async getById(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
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
  @HttpCode(HttpStatus.NO_CONTENT)
  async update(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() dto: UpdateShiftTemplateDto,
  ): Promise<void> {
    const existing = await this.templateRepo.findById(id, companyId);
    if (!existing) throw new NotFoundException(`ShiftTemplate ${id} not found`);
    await this.templateRepo.updatePartial(id, companyId, dto);
  }

  /**
   * DELETE /shift-templates/:id?companyId=...
   * Soft delete — is_active=false + deleted_at=NOW(). Assignments ya
   * generados quedan intactos.
   */
  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ): Promise<{ success: boolean }> {
    await this.templateRepo.delete(id, companyId);
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
    };
  }
}

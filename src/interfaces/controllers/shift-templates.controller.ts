import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Logger,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { IShiftTemplateRepository } from '../../domain/repositories/shift-template.repository';
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
    });

    await this.templateRepo.save(template);
    return this.toDto(template);
  }

  /**
   * DELETE /shift-templates/:id?companyId=...
   * Removes a template (shifts already generated are preserved).
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
    };
  }
}

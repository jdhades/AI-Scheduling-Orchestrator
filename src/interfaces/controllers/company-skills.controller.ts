import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import {
  COMPANY_SKILL_REPOSITORY,
  type ICompanySkillRepository,
} from '../../domain/repositories/company-skill.repository';
import { CompanySkill } from '../../domain/aggregates/company-skill.aggregate';

export class CreateCompanySkillDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;
}

/**
 * CompanySkillsController
 *
 * GET    /company-skills                   — lista skills activas de la empresa
 * GET    /company-skills/:id               — obtener una
 * POST   /company-skills                   — agrega una skill al catálogo de la empresa
 * DELETE /company-skills/:id               — soft delete del link (la skill
 *                                            global queda para otras empresas)
 *
 * Sin PATCH: renombrar una skill afectaría a otras empresas que la usan.
 * Si el manager quiere cambiar el nombre, DELETE + POST con el nombre nuevo.
 */
@Controller('company-skills')
export class CompanySkillsController {
  constructor(
    @Inject(COMPANY_SKILL_REPOSITORY)
    private readonly skillRepo: ICompanySkillRepository,
  ) {}

  @Get()
  async list(@CurrentCompany() companyId: string): Promise<object[]> {
    const rows = await this.skillRepo.findAllByCompany(companyId);
    return rows.map(this.toDto);
  }

  @Get(':id')
  async getById(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<object> {
    const s = await this.skillRepo.findById(id, companyId);
    if (!s) throw new NotFoundException(`CompanySkill ${id} not found`);
    return this.toDto(s);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentCompany() companyId: string,
    @Body() dto: CreateCompanySkillDto,
  ): Promise<object> {
    const skill = await this.skillRepo.create(companyId, dto.name);
    return this.toDto(skill);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    const existing = await this.skillRepo.findById(id, companyId);
    if (!existing) throw new NotFoundException(`CompanySkill ${id} not found`);
    await this.skillRepo.delete(id, companyId);
  }

  private toDto(s: CompanySkill): object {
    return {
      id: s.id,
      companyId: s.companyId,
      name: s.name,
    };
  }
}

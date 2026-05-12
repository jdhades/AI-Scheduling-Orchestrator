import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { CreateSemanticRuleCommand } from '../../application/commands/create-semantic-rule.command';
import { DeleteSemanticRuleCommand } from '../../application/commands/delete-semantic-rule.command';
import { UpdateSemanticRuleMetadataCommand } from '../../application/commands/update-semantic-rule-metadata.command';
import { UpdateSemanticRuleTextCommand } from '../../application/commands/update-semantic-rule-text.command';
import { GetSemanticRulesQuery } from '../../application/queries/get-semantic-rules.query';
import { GetSemanticRuleByIdQuery } from '../../application/queries/get-semantic-rule-by-id.query';
import { CreateSemanticRuleDto } from '../dtos/create-semantic-rule.dto';
import {
  UpdateSemanticRuleMetadataDto,
  UpdateSemanticRuleTextDto,
} from '../dtos/update-semantic-rule.dto';
import type { CreateSemanticRuleResult } from '../../application/handlers/create-semantic-rule.handler';
import type { SemanticRuleDto } from '../../application/handlers/get-semantic-rules.handler';

/**
 * RuleController
 *
 * API REST para gestión de reglas semánticas.
 * El aislamiento multi-tenant se garantiza via Query param companyId
 * (mismo patrón que ScheduleController — el TenantMiddleware lo gestiona globalmente).
 *
 * Endpoints:
 *   POST   /rules/semantic                  — Crear regla semántica
 *   GET    /rules/semantic                  — Listar reglas de la empresa
 *   DELETE /rules/semantic/:id              — Soft-delete de una regla
 */
@Controller('rules/semantic')
export class RuleController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  /**
   * POST /rules/semantic?companyId=UUID
   *
   * Crea una nueva regla semántica en lenguaje natural.
   * El EmbeddingService genera el vector automáticamente.
   *
   * Respuesta: { id: UUID, embeddingGenerated: boolean }
   *   embeddingGenerated=false significa que la regla fue guardada pero
   *   sin vector — ocurre si la API de Gemini estaba caída.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateSemanticRuleDto,
    @CurrentCompany() companyId: string,
  ): Promise<CreateSemanticRuleResult> {
    return this.commandBus.execute(
      new CreateSemanticRuleCommand(
        companyId,
        dto.ruleText,
        dto.priorityLevel,
        dto.ruleType,
        dto.createdBy,
        dto.metadata,
      ),
    );
  }

  /**
   * GET /rules/semantic?companyId=UUID&ruleType=restriction
   *
   * Lista todas las reglas activas de la empresa.
   * Filtro opcional por tipo: restriction | preference | requirement
   */
  @Get()
  async findAll(
    @CurrentCompany() companyId: string,
    @Query('ruleType') ruleType?: 'restriction' | 'preference' | 'requirement',
  ): Promise<SemanticRuleDto[]> {
    return this.queryBus.execute(
      new GetSemanticRulesQuery(companyId, ruleType),
    );
  }

  /**
   * GET /rules/semantic/:id?companyId=UUID
   *
   * Devuelve una regla puntual con su texto, metadata, structure y flags.
   * 404 si no existe, pertenece a otra empresa, o fue soft-deleted.
   */
  @Get(':id')
  async getById(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<unknown> {
    return this.queryBus.execute(new GetSemanticRuleByIdQuery(id, companyId));
  }

  /**
   * PATCH /rules/semantic/:id?companyId=UUID
   *
   * Actualiza metadata (priority, is_active, expires_at, branch/department
   * scope). Operación barata: NO re-genera embedding ni structure. Para
   * cambiar el texto usar PATCH /rules/semantic/:id/text.
   */
  @Patch(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async updateMetadata(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
    @Body() dto: UpdateSemanticRuleMetadataDto,
  ): Promise<void> {
    const patch = {
      priorityLevel: dto.priorityLevel,
      isActive: dto.isActive,
      branchId: dto.branchId,
      departmentId: dto.departmentId,
      // expiresAt: el DTO lo trae como string (ISO) o null; convertimos a Date.
      expiresAt:
        dto.expiresAt === undefined
          ? undefined
          : dto.expiresAt === null
            ? null
            : new Date(dto.expiresAt),
    };
    await this.commandBus.execute(
      new UpdateSemanticRuleMetadataCommand(id, companyId, patch),
    );
  }

  /**
   * PATCH /rules/semantic/:id/text?companyId=UUID
   *
   * Cambia el texto de la regla. Operación CARA: re-genera embedding +
   * re-extrae estructura con LLM. La UI debería mostrar un confirm
   * ("esto reprocesa la regla con IA") antes de llamar.
   */
  @Patch(':id/text')
  async updateText(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
    @Body() dto: UpdateSemanticRuleTextDto,
  ): Promise<unknown> {
    return this.commandBus.execute(
      new UpdateSemanticRuleTextCommand(id, companyId, dto.ruleText),
    );
  }

  /**
   * DELETE /rules/semantic/:id?companyId=UUID
   *
   * Soft-delete de una regla semántica.
   * La regla permanece en DB con is_active=false + deleted_at=NOW() para auditoría.
   * Retorna 404 si la regla no existe o pertenece a otra empresa.
   */
  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<{ deleted: boolean }> {
    const result = await this.commandBus.execute(
      new DeleteSemanticRuleCommand(id, companyId),
    );

    if (!result.deleted) {
      throw new NotFoundException(
        `Semantic rule ${id} not found for company ${companyId}`,
      );
    }

    return { deleted: true };
  }
}

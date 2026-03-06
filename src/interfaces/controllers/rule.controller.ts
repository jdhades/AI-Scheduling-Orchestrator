import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    Post,
    Query,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { CreateSemanticRuleCommand } from '../../application/commands/create-semantic-rule.command';
import { DeleteSemanticRuleCommand } from '../../application/commands/delete-semantic-rule.command';
import { GetSemanticRulesQuery } from '../../application/queries/get-semantic-rules.query';
import { CreateSemanticRuleDto } from '../dtos/create-semantic-rule.dto';
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
    ) { }

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
        @Query('companyId') companyId: string,
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
        @Query('companyId') companyId: string,
        @Query('ruleType') ruleType?: 'restriction' | 'preference' | 'requirement',
    ): Promise<SemanticRuleDto[]> {
        return this.queryBus.execute(
            new GetSemanticRulesQuery(companyId, ruleType),
        );
    }

    /**
     * DELETE /rules/semantic/:id?companyId=UUID
     *
     * Soft-delete de una regla semántica.
     * La regla permanece en DB con is_active=false para auditoría.
     * Retorna 404 si la regla no existe o pertenece a otra empresa.
     */
    @Delete(':id')
    async remove(
        @Param('id') id: string,
        @Query('companyId') companyId: string,
    ): Promise<{ deleted: boolean }> {
        const result = await this.commandBus.execute(
            new DeleteSemanticRuleCommand(id, companyId),
        );

        if (!result.deleted) {
            throw new NotFoundException(`Semantic rule ${id} not found for company ${companyId}`);
        }

        return { deleted: true };
    }
}

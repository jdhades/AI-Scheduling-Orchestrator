import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { GenerateScheduleCommand } from '../../application/commands/generate-schedule.command';
import { GenerateHybridScheduleCommand } from '../../application/commands/generate-hybrid-schedule.command';
import { GetCompanyScheduleQuery } from '../../application/queries/get-company-schedule.query';
import { GenerateScheduleDto } from '../dtos/generate-schedule.dto';
import type { GenerateScheduleResult } from '../../application/handlers/generate-schedule.handler';
import type { HybridScheduleResult } from '../../application/handlers/generate-hybrid-schedule.handler';
import type { ShiftAssignment } from '../../domain/aggregates/shift-assignment.aggregate';

/**
 * ScheduleController
 *
 * Endpoints del motor de scheduling:
 *   POST /schedules/generate        — Horario determinístico (E2)
 *   POST /schedules/generate/hybrid — Horario híbrido LLM + algoritmo (E3 Prompt Orchestrator)
 *   GET  /schedules                 — Consulta el horario de una semana
 *
 * El aislamiento multi-tenant está garantizado por TenantMiddleware (global).
 */
@Controller('schedules')
export class ScheduleController {
    constructor(
        private readonly commandBus: CommandBus,
        private readonly queryBus: QueryBus,
    ) { }

    /**
     * POST /schedules/generate
     *
     * Genera el horario completo de la empresa para la semana indicada
     * usando el motor determinístico (cost / fairness / hybrid).
     */
    @Post('generate')
    async generate(
        @Body() dto: GenerateScheduleDto,
        @Query('companyId') companyId: string,
    ): Promise<GenerateScheduleResult> {
        return this.commandBus.execute(
            new GenerateScheduleCommand(
                companyId,
                dto.weekStart,
                dto.strategy,
                dto.maxFairnessDeviation,
            ),
        );
    }

    /**
     * POST /schedules/generate/hybrid
     *
     * Modo Prompt Orchestrator: el LLM propone las asignaciones y el algoritmo
     * verifica/corrige. La respuesta incluye métricas de trazabilidad:
     *   - llmAccepted: cuántas propuso correctamente el LLM
     *   - algorithmCorrected: cuántas corrigió el algoritmo
     *   - explanation: resumen en lenguaje natural
     *
     * Body: { weekStart: "YYYY-MM-DD", maxFairnessDeviation?: number }
     */
    @Post('generate/hybrid')
    async generateHybrid(
        @Body() dto: GenerateScheduleDto,
        @Query('companyId') companyId: string,
    ): Promise<HybridScheduleResult> {
        return this.commandBus.execute(
            new GenerateHybridScheduleCommand(
                companyId,
                dto.weekStart,
                dto.maxFairnessDeviation,
            ),
        );
    }

    /**
     * GET /schedules?weekStart=2024-03-04
     *
     * Devuelve todas las asignaciones de turno de la empresa para la semana.
     */
    @Get()
    async getSchedule(
        @Query('weekStart') weekStart: string,
        @Query('companyId') companyId: string,
    ): Promise<ShiftAssignment[]> {
        return this.queryBus.execute(
            new GetCompanyScheduleQuery(companyId, weekStart),
        );
    }
}


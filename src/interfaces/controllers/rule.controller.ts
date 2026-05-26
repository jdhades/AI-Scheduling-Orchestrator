import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';
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
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { CreateSemanticRuleCommand } from '../../application/commands/create-semantic-rule.command';
import { LlmJobDispatcher } from '../../application/jobs/llm-job-dispatcher.service';
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
import {
  ENTITY_AUDIT_SERVICE,
  type IEntityAuditService,
  computeChangeSet,
  snapshotAsChangeSet,
} from '../../domain/audit/entity-audit.service';
import {
  SEMANTIC_RULE_REPOSITORY_TOKEN,
  type ISemanticRuleRepository,
} from '../../domain/repositories/semantic-rule.repository.interface';
import { SemanticRuleAggregate } from '../../domain/aggregates/semantic-rule.aggregate';

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
    private readonly llmDispatcher: LlmJobDispatcher,
    @Inject(SEMANTIC_RULE_REPOSITORY_TOKEN)
    private readonly ruleRepo: ISemanticRuleRepository,
    @Inject(ENTITY_AUDIT_SERVICE)
    private readonly audit: IEntityAuditService,
  ) {}

  /**
   * Snapshot serializable de una regla para el changeset del audit log.
   * Solo campos editables — id/createdAt/companyId quedan fuera porque
   * son inmutables y meten ruido en el diff.
   */
  private auditSnapshot(r: SemanticRuleAggregate): {
    ruleText: string;
    ruleType: string;
    priorityLevel: number;
    isActive: boolean;
    expiresAt: string | null;
    branchId: string | null;
    departmentId: string | null;
  } {
    return {
      ruleText: r.getRuleText(),
      ruleType: r.getRuleType().getValue(),
      priorityLevel: r.getPriority().getValue(),
      isActive: r.getIsActive(),
      expiresAt: r.getExpiresAt()?.toISOString() ?? null,
      branchId: r.getBranchId(),
      departmentId: r.getDepartmentId(),
    };
  }

  /**
   * POST /rules/semantic?companyId=UUID
   *
   * Crea una regla semántica. ASYNC: encola job LLM (embedding +
   * extracción de estructura + duplicate detection) y responde 202
   * con el jobId. Frontend muestra banner "procesando" y refresca
   * la lista cuando llega WS event `LlmJobCompleted`.
   *
   * Path sync legacy disponible con `?async=false` — útil para tests
   * o clients que prefieren bloquear.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async create(
    @Body() dto: CreateSemanticRuleDto,
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
    @Query('async') asyncFlag?: string,
  ): Promise<{ jobId: string } | CreateSemanticRuleResult> {
    if (asyncFlag === 'false') {
      // Path sync legacy.
      const result = await this.commandBus.execute(
        new CreateSemanticRuleCommand(
          companyId,
          dto.ruleText,
          dto.priorityLevel,
          dto.ruleType,
          dto.createdBy,
          dto.metadata,
        ),
      );
      // Audit log — solo si la regla se persistió realmente. Casos
      // donde NO hay persistencia y por tanto no hay entity a loguear:
      //   · isDuplicate=true (semantic dedup contra una existente)
      //   · suggestions presente (suggestion-loop intercepta la creación)
      const persisted = !result.isDuplicate && !result.suggestions;
      if (persisted && result.id) {
        const created = await this.ruleRepo.findById(result.id, companyId);
        if (created) {
          await this.audit.log({
            companyId,
            entityType: 'rule',
            entityId: created.getId(),
            action: 'create',
            changes: snapshotAsChangeSet(this.auditSnapshot(created), 'create'),
            actorUserId: user?.userId ?? null,
            actorEmployeeId: user?.employeeId ?? null,
          });
        }
      }
      return result;
    }
    const jobId = await this.llmDispatcher.enqueue(
      'create_rule',
      {
        companyId,
        actorEmployeeId: user?.employeeId ?? null,
        text: dto.ruleText,
        priority: dto.priorityLevel,
        ruleType: dto.ruleType,
      },
      { label: dto.ruleText.slice(0, 60) },
    );
    return { jobId };
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
    @CurrentUser() user: AuthContext | undefined,
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
    const before = await this.ruleRepo.findById(id, companyId);
    if (!before) throw new NotFoundException(`Semantic rule ${id} not found`);
    await this.commandBus.execute(
      new UpdateSemanticRuleMetadataCommand(id, companyId, patch),
    );
    const after = await this.ruleRepo.findById(id, companyId);
    if (after) {
      const fields = [
        'ruleText',
        'ruleType',
        'priorityLevel',
        'isActive',
        'expiresAt',
        'branchId',
        'departmentId',
      ] as const;
      await this.audit.log({
        companyId,
        entityType: 'rule',
        entityId: id,
        action: 'update',
        changes: computeChangeSet(
          this.auditSnapshot(before),
          this.auditSnapshot(after),
          fields,
        ),
        actorUserId: user?.userId ?? null,
        actorEmployeeId: user?.employeeId ?? null,
      });
    }
  }

  /**
   * PATCH /rules/semantic/:id/text?companyId=UUID
   *
   * Cambia el texto de la regla. Operación CARA: re-genera embedding +
   * re-extrae estructura con LLM. La UI debería mostrar un confirm
   * ("esto reprocesa la regla con IA") antes de llamar.
   */
  @Patch(':id/text')
  @HttpCode(HttpStatus.ACCEPTED)
  async updateText(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
    @Body() dto: UpdateSemanticRuleTextDto,
    @Query('async') asyncFlag?: string,
  ): Promise<{ jobId: string } | unknown> {
    if (asyncFlag === 'false') {
      const before = await this.ruleRepo.findById(id, companyId);
      if (!before) throw new NotFoundException(`Semantic rule ${id} not found`);
      const result = await this.commandBus.execute(
        new UpdateSemanticRuleTextCommand(id, companyId, dto.ruleText),
      );
      const after = await this.ruleRepo.findById(id, companyId);
      if (after) {
        const fields = [
          'ruleText',
          'ruleType',
          'priorityLevel',
          'isActive',
          'expiresAt',
          'branchId',
          'departmentId',
        ] as const;
        await this.audit.log({
          companyId,
          entityType: 'rule',
          entityId: id,
          action: 'update',
          changes: computeChangeSet(
            this.auditSnapshot(before),
            this.auditSnapshot(after),
            fields,
          ),
          actorUserId: user?.userId ?? null,
          actorEmployeeId: user?.employeeId ?? null,
        });
      }
      return result;
    }
    const jobId = await this.llmDispatcher.enqueue(
      'update_rule_text',
      {
        companyId,
        actorEmployeeId: user?.employeeId ?? null,
        ruleId: id,
        newText: dto.ruleText,
      },
      { label: dto.ruleText.slice(0, 60) },
    );
    return { jobId };
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
    @CurrentUser() user: AuthContext | undefined,
  ): Promise<{ deleted: boolean }> {
    const before = await this.ruleRepo.findById(id, companyId);
    const result = await this.commandBus.execute(
      new DeleteSemanticRuleCommand(id, companyId),
    );

    if (!result.deleted) {
      throw new NotFoundException(
        `Semantic rule ${id} not found for company ${companyId}`,
      );
    }

    if (before) {
      await this.audit.log({
        companyId,
        entityType: 'rule',
        entityId: id,
        action: 'delete',
        changes: snapshotAsChangeSet(this.auditSnapshot(before), 'delete'),
        actorUserId: user?.userId ?? null,
        actorEmployeeId: user?.employeeId ?? null,
      });
    }

    return { deleted: true };
  }
}

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
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { CompanyPolicy } from '../../domain/aggregates/company-policy.aggregate';
import {
  COMPANY_POLICY_REPOSITORY,
  type ICompanyPolicyRepository,
} from '../../domain/repositories/company-policy.repository';
import { PolicyInterpreterRegistry } from '../../domain/services/policy-interpreter-registry';
import { CompanyPolicyCreator } from '../../domain/services/company-policy-creator.service';
import { LlmJobDispatcher } from '../../application/jobs/llm-job-dispatcher.service';
import type { CreatePolicyJobPayload } from '../../infrastructure/queue/job-types';
import type { PolicyScope } from '../../domain/aggregates/company-policy.aggregate';

class PolicyScopeDto {
  @IsIn(['company', 'branch', 'department', 'employee'])
  type!: 'company' | 'branch' | 'department' | 'employee';

  /** UUID del target (branch / department / employee). NULL sii type='company'. */
  @IsOptional()
  @IsString()
  id?: string | null;
}

export class CreateCompanyPolicyDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  text!: string;

  @IsIn(['hard', 'soft'])
  severity!: 'hard' | 'soft';

  /** Phase 14.1 — alcance de la policy. Default: tenant-wide (company). */
  @IsOptional()
  @IsObject()
  scope?: PolicyScopeDto;

  @IsOptional()
  @IsString()
  effectiveFrom?: string;

  @IsOptional()
  @IsString()
  createdBy?: string;

  /**
   * Si true, el creator salta el suggestion-loop (no consulta al
   * rephrase service). Útil cuando el manager YA recibió sugerencias
   * y prefiere guardar su texto original en vez de aceptar una de
   * las reformulaciones propuestas — la policy cae directo a
   * `llm_runtime` (severity=hard) o `llm_only` puro (severity=soft).
   */
  @IsOptional()
  @IsBoolean()
  skipSuggestions?: boolean;
}

export class UpdateCompanyPolicyDto {
  @IsOptional()
  @IsString()
  @MinLength(10)
  text?: string;

  @IsOptional()
  @IsIn(['hard', 'soft'])
  severity?: 'hard' | 'soft';

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;
}

interface CompanyPolicyResponse {
  id: string;
  companyId: string;
  text: string;
  severity: 'hard' | 'soft';
  /** Phase 14.1 — alcance al que aplica la policy. */
  scope: {
    type: 'company' | 'branch' | 'department' | 'employee';
    id: string | null;
  };
  params: Record<string, unknown>;
  interpreterId: string | null;
  /** True si el sistema tiene un interpreter en código que aplica esta
   *  policy en el solver. False = LLM-only (se pasa al prompt). */
  hasInterpreter: boolean;
  isActive: boolean;
  effectiveFrom: string;
  createdAt: string;
  createdBy: string | null;
}

/**
 * Respuesta del POST /company-policies. Sprint async-policies (2026-05-26)
 * unificó el path en async: el endpoint encola un job pg-boss y responde
 * 202 con el jobId. El frontend muestra el banner global de progreso y
 * refresca la lista al recibir `LlmJobCompleted` por WS.
 */
type CreateCompanyPolicyResponse = {
  status: 'queued';
  jobId: string;
};

/**
 * CompanyPoliciesController
 *
 * GET    /company-policies                   — lista todas las policies del tenant
 * GET    /company-policies/:id               — obtiene una
 * POST   /company-policies                   — crea (intenta matchear interpreter)
 * PATCH  /company-policies/:id               — toggle isActive / cambia params /
 *                                              reemplaza text (limpia interpreter)
 * DELETE /company-policies/:id               — soft delete
 */
@Controller('company-policies')
export class CompanyPoliciesController {
  constructor(
    @Inject(COMPANY_POLICY_REPOSITORY)
    private readonly policyRepo: ICompanyPolicyRepository,
    private readonly registry: PolicyInterpreterRegistry,
    private readonly creator: CompanyPolicyCreator,
    private readonly jobDispatcher: LlmJobDispatcher,
    @Inject(ENTITY_AUDIT_SERVICE)
    private readonly audit: IEntityAuditService,
  ) {}

  private readonly auditFields = [
    'text',
    'severity',
    'isActive',
    'params',
  ] as const;

  private auditSnapshot(p: CompanyPolicy): {
    text: string;
    severity: 'hard' | 'soft';
    isActive: boolean;
    params: Record<string, unknown>;
  } {
    return {
      text: p.getText(),
      severity: p.getSeverity().getValue(),
      isActive: p.getIsActive(),
      params: p.getParams(),
    };
  }

  @Get()
  async list(
    @CurrentCompany() companyId: string,
  ): Promise<CompanyPolicyResponse[]> {
    const policies = await this.policyRepo.findAllByCompany(companyId);
    return policies.map((p) => this.toDto(p));
  }

  @Get(':id')
  async getById(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<CompanyPolicyResponse> {
    const policy = await this.policyRepo.findById(id, companyId);
    if (!policy) {
      throw new NotFoundException(`CompanyPolicy ${id} not found`);
    }
    return this.toDto(policy);
  }

  /**
   * Sprint async-policies (2026-05-26): creación encolada vía pg-boss.
   * Antes el HTTP request bloqueaba ~20-30s mientras Qwen matcheaba
   * interpreters; el frontend cortaba a los 30s y la policy quedaba a
   * medias. Ahora:
   *   1. Encolamos el job → response 202 con jobId al toque
   *   2. Worker (LlmJobWorker) corre creator.create() en background
   *   3. WS event `LlmJobCompleted` con tipo `create_policy` notifica
   *      al frontend que invalida la query de la lista.
   *   4. Audit log se persiste DESPUÉS del job (no acá), porque el
   *      worker es quien tiene el policy.id resultante. TODO opcional:
   *      pasar `actorUserId` al payload del job para que el worker
   *      audite con esa info — por ahora el audit registra solo el
   *      actorEmployeeId.
   */
  @Post()
  @Requires('policies:write')
  @HttpCode(HttpStatus.ACCEPTED)
  async create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
    @Body() dto: CreateCompanyPolicyDto,
  ): Promise<CreateCompanyPolicyResponse> {
    const scope: PolicyScope | undefined = dto.scope
      ? {
          type: dto.scope.type,
          id: dto.scope.type === 'company' ? null : (dto.scope.id ?? null),
        }
      : undefined;

    const payload: CreatePolicyJobPayload = {
      companyId,
      actorEmployeeId: user?.employeeId ?? null,
      text: dto.text,
      severity: dto.severity,
      scope,
      effectiveFrom: dto.effectiveFrom,
    };

    const jobId = await this.jobDispatcher.enqueue('create_policy', payload, {
      label: dto.text.slice(0, 80),
    });
    return { status: 'queued', jobId };
  }

  @Patch(':id')
  @Requires('policies:write')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
    @Body() dto: UpdateCompanyPolicyDto,
  ): Promise<CompanyPolicyResponse> {
    const policy = await this.policyRepo.findById(id, companyId);
    if (!policy) {
      throw new NotFoundException(`CompanyPolicy ${id} not found`);
    }
    const beforeSnap = this.auditSnapshot(policy);

    // text reemplazado → re-matchear interpreter contra el texto nuevo.
    if (dto.text !== undefined && dto.text !== policy.getText()) {
      policy.replaceText(dto.text);
      const interpreter = this.registry.findMatch(policy.getText());
      if (interpreter) {
        const params = await interpreter.extractParams(policy.getText());
        policy.attachInterpreter(interpreter.id, params);
      }
    }

    if (dto.isActive !== undefined) {
      policy.setActive(dto.isActive);
    }

    // Cambiar params manualmente (override del extractor) — útil cuando
    // el manager quiere ajustar fine-grain sin reescribir el texto.
    if (dto.params !== undefined && policy.hasInterpreter()) {
      const interpreterId = policy.getInterpreterId();
      if (interpreterId) {
        policy.attachInterpreter(interpreterId, dto.params);
      }
    }

    await this.policyRepo.save(policy);
    await this.audit.log({
      companyId,
      entityType: 'company_policy',
      entityId: id,
      action: 'update',
      changes: computeChangeSet(
        beforeSnap,
        this.auditSnapshot(policy),
        this.auditFields,
      ),
      actorUserId: user?.userId ?? null,
      actorEmployeeId: user?.employeeId ?? null,
    });
    return this.toDto(policy);
  }

  @Delete(':id')
  @Requires('policies:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
  ): Promise<void> {
    const existing = await this.policyRepo.findById(id, companyId);
    if (!existing) {
      throw new NotFoundException(`CompanyPolicy ${id} not found`);
    }
    await this.policyRepo.delete(id, companyId);
    await this.audit.log({
      companyId,
      entityType: 'company_policy',
      entityId: id,
      action: 'delete',
      changes: snapshotAsChangeSet(this.auditSnapshot(existing), 'delete'),
      actorUserId: user?.userId ?? null,
      actorEmployeeId: user?.employeeId ?? null,
    });
  }

  private toDto(policy: CompanyPolicy): CompanyPolicyResponse {
    return {
      id: policy.getId(),
      companyId: policy.getCompanyId(),
      text: policy.getText(),
      severity: policy.getSeverity().getValue(),
      scope: policy.getScope(),
      params: policy.getParams(),
      interpreterId: policy.getInterpreterId(),
      hasInterpreter: policy.hasInterpreter(),
      isActive: policy.getIsActive(),
      effectiveFrom: policy.getEffectiveFrom(),
      createdAt: policy.getCreatedAt().toISOString(),
      createdBy: policy.getCreatedBy(),
    };
  }
}

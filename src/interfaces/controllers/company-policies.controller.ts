import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { Requires } from '../../infrastructure/auth/decorators/requires.decorator';
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
import type { RephraseSuggestion } from '../../domain/services/rule-rephrase.service.interface';
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
  scope: { type: 'company' | 'branch' | 'department' | 'employee'; id: string | null };
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
 * Respuesta del POST /company-policies. Discriminated union:
 *
 *   - 'created'              : la policy se persistió. Si interpreterId
 *                              es null, queda como LLM-only (el solver
 *                              la pasa al prompt de schedule generation).
 *
 *   - 'needs_clarification' : el sistema no encontró un patrón aplicable
 *                              y el LLM propuso reformulaciones. La policy
 *                              NO se persistió. El frontend muestra las
 *                              sugerencias y el manager re-submitea.
 */
type CreateCompanyPolicyResponse =
  | { status: 'created'; policy: CompanyPolicyResponse }
  | {
      status: 'needs_clarification';
      reason: string;
      suggestions: RephraseSuggestion[];
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
  ) {}

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

  @Post()
  @Requires('policies:write')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentCompany() companyId: string,
    @Body() dto: CreateCompanyPolicyDto,
  ): Promise<CreateCompanyPolicyResponse> {
    // Toda la lógica vive en CompanyPolicyCreator (commit P1) — el
    // controller solo traduce DTO ↔ resultado HTTP. Eso permite que el
    // MessageRouter de WhatsApp reuse el mismo flow sin duplicación.
    // Phase 14.1 — el caller puede mandar scope explícito; default tenant-wide.
    const scope: PolicyScope | undefined = dto.scope
      ? {
          type: dto.scope.type,
          id: dto.scope.type === 'company' ? null : dto.scope.id ?? null,
        }
      : undefined;

    const result = await this.creator.create({
      companyId,
      text: dto.text,
      severity: dto.severity,
      scope,
      effectiveFrom: dto.effectiveFrom,
      createdBy: dto.createdBy ?? null,
      skipSuggestions: dto.skipSuggestions,
    });

    if (result.status === 'needs_clarification') {
      return {
        status: 'needs_clarification',
        reason: result.reason,
        suggestions: result.suggestions,
      };
    }
    return { status: 'created', policy: this.toDto(result.policy) };
  }

  @Patch(':id')
  @Requires('policies:write')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
    @Body() dto: UpdateCompanyPolicyDto,
  ): Promise<CompanyPolicyResponse> {
    const policy = await this.policyRepo.findById(id, companyId);
    if (!policy) {
      throw new NotFoundException(`CompanyPolicy ${id} not found`);
    }

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
    return this.toDto(policy);
  }

  @Delete(':id')
  @Requires('policies:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    const existing = await this.policyRepo.findById(id, companyId);
    if (!existing) {
      throw new NotFoundException(`CompanyPolicy ${id} not found`);
    }
    await this.policyRepo.delete(id, companyId);
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

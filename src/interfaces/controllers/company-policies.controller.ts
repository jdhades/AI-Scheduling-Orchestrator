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
import { randomUUID } from 'crypto';
import { CompanyPolicy } from '../../domain/aggregates/company-policy.aggregate';
import {
  COMPANY_POLICY_REPOSITORY,
  type ICompanyPolicyRepository,
} from '../../domain/repositories/company-policy.repository';
import { PolicyInterpreterRegistry } from '../../domain/services/policy-interpreter-registry';
import {
  RULE_REPHRASE_SERVICE,
  type IRuleRephraseService,
  type RephraseSuggestion,
} from '../../domain/services/rule-rephrase.service.interface';
import { PolicySeverity } from '../../domain/value-objects/policy-severity.vo';

export class CreateCompanyPolicyDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  text!: string;

  @IsIn(['hard', 'soft'])
  severity!: 'hard' | 'soft';

  @IsOptional()
  @IsString()
  effectiveFrom?: string;

  @IsOptional()
  @IsString()
  createdBy?: string;
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
    @Inject(RULE_REPHRASE_SERVICE)
    private readonly rephraseService: IRuleRephraseService,
  ) {}

  @Get()
  async list(
    @Query('companyId') companyId: string,
  ): Promise<CompanyPolicyResponse[]> {
    const policies = await this.policyRepo.findAllByCompany(companyId);
    return policies.map((p) => this.toDto(p));
  }

  @Get(':id')
  async getById(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ): Promise<CompanyPolicyResponse> {
    const policy = await this.policyRepo.findById(id, companyId);
    if (!policy) {
      throw new NotFoundException(`CompanyPolicy ${id} not found`);
    }
    return this.toDto(policy);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Query('companyId') companyId: string,
    @Body() dto: CreateCompanyPolicyDto,
  ): Promise<CreateCompanyPolicyResponse> {
    const text = dto.text.trim();

    // Caso 1: el registry encuentra un interpreter → extrae params,
    // adjunta y persiste. Camino feliz.
    const interpreter = this.registry.findMatch(text);
    if (interpreter) {
      const policy = CompanyPolicy.create({
        id: randomUUID(),
        companyId,
        text,
        severity: PolicySeverity.create(dto.severity),
        effectiveFrom: dto.effectiveFrom,
        createdBy: dto.createdBy ?? null,
      });
      const params = await interpreter.extractParams(text);
      policy.attachInterpreter(interpreter.id, params);
      await this.policyRepo.save(policy);
      return { status: 'created', policy: this.toDto(policy) };
    }

    // Caso 2: ningún interpreter matcheó. Pedimos sugerencias al LLM.
    const interpreterHints = this.registry.getAvailableIds().map((id) => {
      const itp = this.registry.getById(id);
      return { id, description: itp?.description ?? '' };
    });
    const suggestions = await this.rephraseService.suggest({
      originalText: text,
      reason: 'no_interpreter_matched',
      interpreters: interpreterHints,
    });

    if (suggestions.length > 0) {
      // El manager elige una y el frontend re-submitea con el texto elegido.
      // Nada se persiste todavía — evitamos orphan policies que el solver ignora.
      return {
        status: 'needs_clarification',
        reason: 'no_interpreter_matched',
        suggestions,
      };
    }

    // Caso 3: ningún interpreter + el LLM no propuso nada aplicable.
    // Persistimos como LLM-only para no bloquear al manager — el solver
    // la pasa al prompt de schedule generation aunque no la pueda
    // estructurar deterministicamente.
    const policy = CompanyPolicy.create({
      id: randomUUID(),
      companyId,
      text,
      severity: PolicySeverity.create(dto.severity),
      effectiveFrom: dto.effectiveFrom,
      createdBy: dto.createdBy ?? null,
    });
    await this.policyRepo.save(policy);
    return { status: 'created', policy: this.toDto(policy) };
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
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
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
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

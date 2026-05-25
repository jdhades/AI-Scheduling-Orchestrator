import { randomUUID } from 'crypto';
import { PolicySeverity } from '../value-objects/policy-severity.vo';

/**
 * Scope al que aplica la policy. Phase 14.1 — antes era implícito
 * "tenant-wide"; ahora se modela explícito para permitir reglas por
 * sucursal / departamento / empleado coexistiendo con la regla global.
 */
export type PolicyScopeType = 'company' | 'branch' | 'department' | 'employee';
export interface PolicyScope {
  type: PolicyScopeType;
  /** id del target. NULL sii type='company'. */
  id: string | null;
}

/**
 * CompanyPolicy — Aggregate Root
 *
 * Política en lenguaje natural con scope explícito. A diferencia de
 * SemanticRule (caso particular textual: "Pablo no trabaja los lunes"),
 * una CompanyPolicy es un invariante estructural ("descanso mínimo de
 * 11h entre turnos"). Reemplaza al hardcode del solver y permite que
 * cada tenant configure reglas a 4 niveles distintos:
 *
 *   - company    : aplica a todos los empleados del tenant.
 *   - branch     : aplica a empleados de una sucursal.
 *   - department : aplica a empleados de un departamento.
 *   - employee   : aplica a un empleado puntual.
 *
 * Mecanismo abierto: el campo `interpreterId` es opcional. Si el sistema
 * tiene un PolicyInterpreter en código que matchea el texto, lo enchufa
 * (constraint deterministic + rápido). Si no, queda como `interpreterId
 * = null` y la política se pasa al LLM en la fase de schedule
 * generation/repair como contexto. Eso permite multi-tenant flexible
 * sin enum cerrado.
 *
 * Invariantes:
 *   - text no vacío (mínimo 10 chars).
 *   - severity ∈ {'hard', 'soft'} (validado por el VO).
 *   - scope.type ∈ {company, branch, department, employee}.
 *   - scope.id IS NULL sii scope.type='company'.
 *   - params es un objeto plano (no validamos shape acá; cada
 *     interpreter tiene su propio schema).
 */
export interface CompanyPolicyProps {
  id: string;
  companyId: string;
  text: string;
  severity: PolicySeverity;
  /** Phase 14.1 — alcance al que aplica esta policy. */
  scope: PolicyScope;
  /** Params estructurados extraídos por un interpreter o vacío. */
  params: Record<string, unknown>;
  /** Null si ningún interpreter del registry matcheó este texto. */
  interpreterId: string | null;
  isActive: boolean;
  /** Fecha desde la cual la policy aplica (YYYY-MM-DD). */
  effectiveFrom: string;
  createdAt: Date;
  createdBy: string | null;
}

export interface CreateCompanyPolicyInput {
  companyId: string;
  text: string;
  severity: PolicySeverity;
  /** Phase 14.1. Default: { type:'company', id:null }. */
  scope?: PolicyScope;
  params?: Record<string, unknown>;
  interpreterId?: string | null;
  effectiveFrom?: string;
  createdBy?: string | null;
  /** Permite que el caller imponga el id (útil para tests / seeding). */
  id?: string;
}

const SCOPE_TYPES: ReadonlySet<PolicyScopeType> = new Set([
  'company',
  'branch',
  'department',
  'employee',
]);

function validateScope(scope: PolicyScope): void {
  if (!SCOPE_TYPES.has(scope.type)) {
    throw new Error(
      `CompanyPolicy scope.type must be one of company|branch|department|employee; got "${scope.type}".`,
    );
  }
  const isCompany = scope.type === 'company';
  if (isCompany && scope.id !== null) {
    throw new Error(
      'CompanyPolicy: scope.id must be null when scope.type="company".',
    );
  }
  if (
    !isCompany &&
    (scope.id === null || scope.id === undefined || scope.id === '')
  ) {
    throw new Error(
      `CompanyPolicy: scope.id is required when scope.type="${scope.type}".`,
    );
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_TEXT_LENGTH = 10;

const todayISO = () => new Date().toISOString().slice(0, 10);

export class CompanyPolicy {
  private constructor(private readonly props: CompanyPolicyProps) {}

  static create(input: CreateCompanyPolicyInput): CompanyPolicy {
    const text = input.text.trim();
    if (text.length < MIN_TEXT_LENGTH) {
      throw new Error(
        `CompanyPolicy text must be at least ${MIN_TEXT_LENGTH} characters; got ${text.length}.`,
      );
    }
    const effectiveFrom = input.effectiveFrom ?? todayISO();
    if (!ISO_DATE_RE.test(effectiveFrom)) {
      throw new Error(
        `CompanyPolicy effectiveFrom must be YYYY-MM-DD; got "${effectiveFrom}".`,
      );
    }

    const scope: PolicyScope = input.scope ?? { type: 'company', id: null };
    validateScope(scope);

    return new CompanyPolicy({
      id: input.id ?? randomUUID(),
      companyId: input.companyId,
      text,
      severity: input.severity,
      scope,
      params: input.params ?? {},
      interpreterId: input.interpreterId ?? null,
      isActive: true,
      effectiveFrom,
      createdAt: new Date(),
      createdBy: input.createdBy ?? null,
    });
  }

  static fromPersistence(props: CompanyPolicyProps): CompanyPolicy {
    validateScope(props.scope);
    return new CompanyPolicy(props);
  }

  /** Asocia un interpreter (cuando el registry detecta el patrón post-create). */
  attachInterpreter(
    interpreterId: string,
    params: Record<string, unknown>,
  ): void {
    if (!interpreterId) {
      throw new Error('attachInterpreter: interpreterId cannot be empty');
    }
    this.props.interpreterId = interpreterId;
    this.props.params = params;
  }

  /** Quita el interpreter (la política pasa a LLM-only). */
  detachInterpreter(): void {
    this.props.interpreterId = null;
    this.props.params = {};
  }

  /** Toggle de activación (sin tocar el resto de los campos). */
  setActive(active: boolean): void {
    this.props.isActive = active;
  }

  /**
   * Reemplaza el texto y limpia el interpreter (debe re-evaluarse por el
   * registry contra el nuevo texto, igual que el rewriting de SemanticRule).
   */
  replaceText(newText: string): void {
    const trimmed = newText.trim();
    if (trimmed.length < MIN_TEXT_LENGTH) {
      throw new Error(
        `CompanyPolicy text must be at least ${MIN_TEXT_LENGTH} characters; got ${trimmed.length}.`,
      );
    }
    this.props.text = trimmed;
    this.props.interpreterId = null;
    this.props.params = {};
  }

  // -- Getters ------------------------------------------------------------
  getId(): string {
    return this.props.id;
  }
  getCompanyId(): string {
    return this.props.companyId;
  }
  getText(): string {
    return this.props.text;
  }
  getSeverity(): PolicySeverity {
    return this.props.severity;
  }
  getParams(): Record<string, unknown> {
    return this.props.params;
  }
  getInterpreterId(): string | null {
    return this.props.interpreterId;
  }
  hasInterpreter(): boolean {
    return this.props.interpreterId !== null;
  }
  getIsActive(): boolean {
    return this.props.isActive;
  }
  getEffectiveFrom(): string {
    return this.props.effectiveFrom;
  }
  getCreatedAt(): Date {
    return this.props.createdAt;
  }
  getCreatedBy(): string | null {
    return this.props.createdBy;
  }
  getScope(): PolicyScope {
    return { ...this.props.scope };
  }
  getScopeType(): PolicyScopeType {
    return this.props.scope.type;
  }
  getScopeId(): string | null {
    return this.props.scope.id;
  }

  /**
   * Decide si la policy aplica al empleado dado, dado su `branchId` y
   * `departmentId`. Lo usa `PolicyEnforcementService` para filtrar shifts
   * antes de pasarlos al interpreter.
   *
   *   - scope=company    → aplica a todos.
   *   - scope=branch     → aplica si emp.branchId === scope.id.
   *   - scope=department → aplica si emp.departmentId === scope.id.
   *   - scope=employee   → aplica si emp.id === scope.id.
   */
  isApplicableTo(emp: {
    id: string;
    branchId: string | null;
    departmentId: string | null;
  }): boolean {
    const { type, id: scopeId } = this.props.scope;
    switch (type) {
      case 'company':
        return true;
      case 'branch':
        return emp.branchId !== null && emp.branchId === scopeId;
      case 'department':
        return emp.departmentId !== null && emp.departmentId === scopeId;
      case 'employee':
        return emp.id === scopeId;
    }
  }

  /** Snapshot inmutable para persistir / serializar. */
  toSnapshot(): CompanyPolicyProps {
    return {
      ...this.props,
      scope: { ...this.props.scope },
      params: { ...this.props.params },
    };
  }
}

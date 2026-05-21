import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  POLICY_INTERPRETERS_TOKEN,
  type PolicyInterpreter,
} from './policy-interpreter.interface';

/**
 * PolicyInterpreterRegistry
 *
 * Mantiene los interpreters disponibles. Para cada policy nueva, intenta
 * matchear con cada interpreter en el orden en que fueron registrados.
 * Devuelve el primer match (o null si ninguno aplica).
 *
 * Wiring NestJS: los interpreters se inyectan vía multi-provider con el
 * token POLICY_INTERPRETERS_TOKEN. El módulo (CompanyPoliciesModule, en
 * commit 2/3) declara cada interpreter individual y los agrupa en un
 * array bajo ese token.
 *
 * Para tests, se puede instanciar pasando los interpreters directo.
 */
@Injectable()
export class PolicyInterpreterRegistry {
  private readonly interpreters: ReadonlyMap<string, PolicyInterpreter>;

  constructor(
    @Optional()
    @Inject(POLICY_INTERPRETERS_TOKEN)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    interpreters: Array<PolicyInterpreter<any>> = [],
  ) {
    const map = new Map<string, PolicyInterpreter>();
    for (const itp of interpreters) {
      if (map.has(itp.id)) {
        throw new Error(
          `PolicyInterpreterRegistry: duplicate interpreter id "${itp.id}"`,
        );
      }
      map.set(itp.id, itp);
    }
    this.interpreters = map;
  }

  /**
   * Lista de IDs disponibles — útil para hints al RuleRephraseService.
   * Excluye interpreters marcados con `catchAll=true` (ej. `llm_runtime`):
   * no tiene sentido proponerle al manager "reformulá hacia el catch-all".
   */
  getAvailableIds(): string[] {
    const ids: string[] = [];
    for (const [id, itp] of this.interpreters) {
      if (!itp.catchAll) ids.push(id);
    }
    return ids;
  }

  /** Lookup directo por id (cuando ya conocemos cuál usar). */
  getById(id: string): PolicyInterpreter | null {
    return this.interpreters.get(id) ?? null;
  }

  /**
   * Todos los interpreters registrados, incluso los catchAll. Pensado
   * para introspección del admin panel — el flujo de matching y los
   * hints al rephrase service siguen usando `getAvailableIds()` /
   * `findMatch()`, no esto.
   */
  getAll(): PolicyInterpreter[] {
    return Array.from(this.interpreters.values());
  }

  /**
   * Busca el primer interpreter cuyo `matches(text)` devuelva true.
   * El orden importa — si dos podrían matchear, prefiere el primero
   * registrado. (En práctica los matchers deberían ser disjuntos; si
   * dos colisionan, vale revisar las heurísticas.)
   */
  findMatch(text: string): PolicyInterpreter | null {
    for (const itp of this.interpreters.values()) {
      if (itp.matches(text)) return itp;
    }
    return null;
  }
}

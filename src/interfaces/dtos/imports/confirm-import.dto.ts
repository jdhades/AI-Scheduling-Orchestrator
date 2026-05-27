import { IsIn, IsObject, IsOptional } from 'class-validator';

/**
 * Body de `POST /imports/staging/:id/confirm`.
 *
 * `decisions`: el owner sobreescribe el plan que el preview había
 * sugerido (create / update / skip por externalId). Si no manda nada,
 * usamos lo que el preview cacheó.
 *
 * `overrides`: parches a campos de entidades por externalId. Útil para
 * filas baja-confianza editadas inline. Estructura `{ externalId →
 * partialEntity }`. La validación strict de cada parche es delegada al
 * committer (depende del tipo de entidad). En Fase 1 NO se exigen.
 */
export class ConfirmImportDto {
  @IsOptional()
  @IsObject()
  decisions?: Record<string, 'create' | 'update' | 'skip'>;

  @IsOptional()
  @IsObject()
  overrides?: Record<string, unknown>;

  @IsOptional()
  @IsIn(['parcial', 'partial', 'all_or_nothing'])
  mode?: 'parcial' | 'partial' | 'all_or_nothing';
}

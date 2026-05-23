import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  Matches,
} from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Body de POST /schedules/clone.
 *
 * Hard cap de 8 semanas destino en una sola llamada — evita que un
 * misclick clone 50 semanas y arme un quilombo masivo. Si el caso real
 * llega, lo subimos; mientras 8 cubre todos los flows que el manager
 * pediría a mano.
 */
export class CloneScheduleDto {
  @Matches(ISO_DATE, { message: 'sourceWeekStart must be YYYY-MM-DD' })
  sourceWeekStart!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @Matches(ISO_DATE, {
    each: true,
    message: 'targetWeekStarts[i] must be YYYY-MM-DD',
  })
  targetWeekStarts!: string[];

  /** Si true, borra assignments existentes en cada target week antes de
   *  clonar. Si false (default), tira 409 cuando alguna target ya tiene. */
  @IsOptional()
  @IsBoolean()
  overwrite?: boolean;
}

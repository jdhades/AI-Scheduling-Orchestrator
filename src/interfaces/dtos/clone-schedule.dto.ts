import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
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
   *  clonar. Si false (default), tira 409 cuando alguna target ya tiene.
   *
   *  Con clone granular (employeeId y/o dayOfWeek set), overwrite aplica
   *  solo al scope filtrado — no toca el resto de la semana destino. */
  @IsOptional()
  @IsBoolean()
  overwrite?: boolean;

  /**
   * Clone granular — solo este empleado. Si se omite, se clonan todos.
   * Combinable con dayOfWeek para clonar un único cell.
   */
  @IsOptional()
  @IsUUID('loose')
  employeeId?: string;

  /**
   * Clone granular — solo este día de la semana. 0=Sunday, 6=Saturday
   * (estándar JS Date.getUTCDay). Si se omite, se clonan los 7 días.
   * El handler mapea por offset de día-de-semana, no por fecha exacta
   * (ya lo hace para el clone full-week — reusamos esa lógica).
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek?: number;
}

import { Injectable, Logger } from '@nestjs/common';
import type { ShiftTemplate } from '../aggregates/shift-template.aggregate';
import { VirtualShiftSlot } from '../value-objects/virtual-shift-slot.vo';

/**
 * ShiftSlotGeneratorService — Domain Service
 *
 * Materializa virtualmente, para una semana dada, los VirtualShiftSlot
 * derivados de los shift_templates activos del tenant. NO persiste nada:
 * los slots existen solo en memoria durante la generación del horario.
 *
 * Reglas:
 *  - Template con `day_of_week` numérico (0..6) → genera slot UN solo día de
 *    esa semana (el día calendario que coincide).
 *  - Template con `day_of_week = null` → genera slot TODOS los días de la
 *    semana (turno genérico recurrente sin día fijo).
 *  - Slots cruzan medianoche si end_time <= start_time (noche).
 *
 * Reemplaza conceptualmente a `ShiftTemplate.instantiateForWeek()` (que
 * producía `Shift` persistidos) + al `InstantiateWeekHandler` completo.
 */
@Injectable()
export class ShiftSlotGeneratorService {
  private readonly logger = new Logger(ShiftSlotGeneratorService.name);

  /**
   * @param templates Templates activos del tenant (filtrar is_active=true antes).
   * @param weekStartUtc 00:00 UTC del primer día de la semana del tenant
   *   (lunes o domingo según `companies.week_starts_on`).
   * @returns Array de VirtualShiftSlot ordenado por date + startTime.
   */
  generateSlotsForWeek(
    templates: ShiftTemplate[],
    weekStartUtc: Date,
  ): VirtualShiftSlot[] {
    const slots: VirtualShiftSlot[] = [];
    const year = weekStartUtc.getUTCFullYear();
    const month = weekStartUtc.getUTCMonth();
    const anchorDate = weekStartUtc.getUTCDate();
    const anchorDow = weekStartUtc.getUTCDay();

    for (const tpl of templates) {
      // day_of_week es `number` en el aggregate hoy; la BD permite null pero el
      // aggregate aún no lo expone (pendiente en iteraciones posteriores).
      // Mientras tanto, todos los templates cargados tienen un día específico.
      const daysToEmit = this.daysToEmitForTemplate(tpl, anchorDow);

      for (const daysFromAnchor of daysToEmit) {
        const slotDate = new Date(
          Date.UTC(year, month, anchorDate + daysFromAnchor),
        );
        const dateISO = slotDate.toISOString().split('T')[0];

        const [startH, startM] = tpl.startTime.split(':').map(Number);
        const [endH, endM] = tpl.endTime.split(':').map(Number);

        const startDateTime = new Date(
          Date.UTC(
            slotDate.getUTCFullYear(),
            slotDate.getUTCMonth(),
            slotDate.getUTCDate(),
            startH,
            startM,
            0,
            0,
          ),
        );
        let endDateTime = new Date(
          Date.UTC(
            slotDate.getUTCFullYear(),
            slotDate.getUTCMonth(),
            slotDate.getUTCDate(),
            endH,
            endM,
            0,
            0,
          ),
        );

        // end_time <= start_time → cruza medianoche
        if (endDateTime <= startDateTime) {
          endDateTime = new Date(endDateTime.getTime() + 24 * 60 * 60 * 1000);
        }

        slots.push(
          VirtualShiftSlot.create({
            templateId: tpl.id,
            companyId: tpl.companyId,
            date: dateISO,
            startTime: startDateTime,
            endTime: endDateTime,
            templateName: tpl.name,
            requiredSkillId: tpl.requiredSkillId,
            requiredEmployees: tpl.requiredEmployees,
            demandScore: tpl.demandScore.value,
            undesirableWeight: tpl.undesirableWeight.value,
          }),
        );
      }
    }

    // Orden estable: date ASC, luego startTime ASC
    slots.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.startTime.getTime() - b.startTime.getTime();
    });

    this.logger.log(
      `Generated ${slots.length} virtual slots from ${templates.length} templates for week ${weekStartUtc.toISOString().split('T')[0]}`,
    );
    return slots;
  }

  /**
   * Offsets en días desde el primer día de la semana del tenant.
   *   - dayOfWeek numérico (JS dow: 0=Dom..6=Sáb) → [offset único]
   *     calculado relativo al `anchorDow` (el dow del weekStart del tenant).
   *   - dayOfWeek null (genérico) → [0..6] (todos los días).
   */
  private daysToEmitForTemplate(
    tpl: ShiftTemplate,
    anchorDow: number,
  ): number[] {
    const dow = tpl.dayOfWeek as number | null | undefined;
    if (dow === null || dow === undefined) {
      return [0, 1, 2, 3, 4, 5, 6];
    }
    return [(dow - anchorDow + 7) % 7];
  }
}

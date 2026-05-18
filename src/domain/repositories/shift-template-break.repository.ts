import type { ShiftTemplateBreak } from '../aggregates/shift-template-break.aggregate';

export const SHIFT_TEMPLATE_BREAK_REPOSITORY = Symbol(
  'SHIFT_TEMPLATE_BREAK_REPOSITORY',
);

/**
 * IShiftTemplateBreakRepository — port para los defaults de break por
 * template. CRUD básico — los breaks default rara vez se mutan a alta
 * frecuencia (typical: el manager los configura una vez por template
 * y olvidá).
 */
export interface IShiftTemplateBreakRepository {
  save(brk: ShiftTemplateBreak): Promise<void>;

  deleteById(id: string, companyId: string): Promise<void>;

  findByTemplateId(
    templateId: string,
    companyId: string,
  ): Promise<ShiftTemplateBreak[]>;

  findById(id: string, companyId: string): Promise<ShiftTemplateBreak | null>;
}

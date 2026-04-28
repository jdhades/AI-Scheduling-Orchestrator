import { CompanySkill } from '../aggregates/company-skill.aggregate';

/**
 * SkillSet — Value Object
 *
 * Envuelve el conjunto de skills de un empleado.
 * Garantiza inmutabilidad y ausencia de duplicados (por skill.id).
 */
export class SkillSet {
  private constructor(private readonly _skills: CompanySkill[]) {}

  static create(skills: CompanySkill[]): SkillSet {
    const ids = skills.map((s) => s.id);
    const unique = new Set(ids);
    if (unique.size !== ids.length) {
      throw new Error('SkillSet cannot contain duplicate skills');
    }
    return new SkillSet([...skills]);
  }

  static empty(): SkillSet {
    return new SkillSet([]);
  }

  has(skillId: string): boolean {
    return this._skills.some((s) => s.id === skillId);
  }

  find(skillId: string): CompanySkill | undefined {
    return this._skills.find((s) => s.id === skillId);
  }

  getAll(): CompanySkill[] {
    return [...this._skills];
  }

  get size(): number {
    return this._skills.length;
  }

  add(skill: CompanySkill): SkillSet {
    if (this.has(skill.id)) {
      throw new Error(`Skill ${skill.id} is already in the SkillSet`);
    }
    return new SkillSet([...this._skills, skill]);
  }

  remove(skillId: string): SkillSet {
    return new SkillSet(this._skills.filter((s) => s.id !== skillId));
  }
}

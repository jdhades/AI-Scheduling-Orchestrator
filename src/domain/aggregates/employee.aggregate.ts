import { AggregateRoot } from '@nestjs/cqrs';
import { PhoneNumber } from '../value-objects/phone-number.vo';
import { ExperienceLevel } from '../value-objects/experience-level.vo';
import { CompanySkill } from '../aggregates/company-skill.aggregate';
import { SkillValidationPolicy } from '../policies/skill-validation.policy';
import { EmployeeRegisteredEvent } from '../events/employee-registered.event';
import { EmployeeAvailability } from '../value-objects/employee-availability.vo';
import { EmployeePreference } from '../value-objects/employee-preference.vo';
import type { WorkingTimePolicyOverrides } from '../value-objects/working-time-policy.vo';

export class Employee extends AggregateRoot {
  private skills: CompanySkill[] = [];
  private availability: EmployeeAvailability[] = [];
  private preferences: EmployeePreference[] = [];

  private constructor(
    public readonly id: string,
    public readonly companyId: string,
    public readonly name: string,
    public readonly role: string,
    private phoneNumber: PhoneNumber,
    private experience: ExperienceLevel,
    public locale: string = 'es',
    public readonly departmentId?: string,
    public readonly contractType?: string,
    public readonly workingTimeOverrides: WorkingTimePolicyOverrides = {},
  ) {
    super();
  }

  static create(
    id: string,
    companyId: string,
    name: string,
    role: string,
    phone: PhoneNumber,
    experience: ExperienceLevel,
    locale: string = 'es',
    departmentId?: string,
    contractType?: string,
    workingTimeOverrides: WorkingTimePolicyOverrides = {},
  ): Employee {
    const employee = new Employee(id, companyId, name, role, phone, experience, locale, departmentId, contractType, workingTimeOverrides);
    employee.apply(new EmployeeRegisteredEvent(id, companyId, phone.value));
    return employee;
  }

  /**
   * Reconstituye el aggregate desde persistencia SIN disparar eventos.
   */
  static fromPersistence(data: {
    id: string;
    companyId: string;
    name: string;
    role: string;
    phoneNumber: PhoneNumber;
    experience: ExperienceLevel;
    locale?: string;
    availability?: EmployeeAvailability[];
    preferences?: EmployeePreference[];
    departmentId?: string;
    contractType?: string;
    workingTimeOverrides?: WorkingTimePolicyOverrides;
  }): Employee {
    const emp = new Employee(
      data.id,
      data.companyId,
      data.name,
      data.role,
      data.phoneNumber,
      data.experience,
      data.locale ?? 'es',
      data.departmentId,
      data.contractType,
      data.workingTimeOverrides ?? {},
    );
    emp.availability = data.availability ?? [];
    emp.preferences = data.preferences ?? [];
    return emp;
  }

  // ─── Locale ──────────────────────────────────────────────────────────────

  updateLocale(newLocale: string): void {
    if (newLocale && newLocale.length === 2) {
      this.locale = newLocale.toLowerCase();
    }
  }

  // ─── Skills ──────────────────────────────────────────────────────────────

  assignSkill(skill: CompanySkill, policy: SkillValidationPolicy) {
    policy.validateEmployee(this, skill);
    if (!this.skills.find((s) => s.equals(skill))) this.skills.push(skill);
  }

  removeSkill(skillId: string) {
    this.skills = this.skills.filter((s) => s.id !== skillId);
  }

  getSkills(): CompanySkill[] {
    return [...this.skills];
  }

  // ─── Availability ─────────────────────────────────────────────────────────

  loadAvailability(windows: EmployeeAvailability[]): void {
    this.availability = windows;
  }

  getAvailability(): EmployeeAvailability[] {
    return [...this.availability];
  }

  /**
   * Hard Constraint: returns true if the employee has no availability records
   * (no restrictions defined → always available), OR if at least one availability
   * window fully covers the proposed shift.
   */
  isAvailable(shiftStart: Date, shiftEnd: Date): boolean {
    if (this.availability.length === 0) return true;
    return this.availability.some((w) => w.coversShift(shiftStart, shiftEnd));
  }

  // ─── Preferences ─────────────────────────────────────────────────────────

  loadPreferences(prefs: EmployeePreference[]): void {
    this.preferences = prefs;
  }

  getPreferences(): EmployeePreference[] {
    return [...this.preferences];
  }

  /**
   * Soft Constraint: returns a combined cost multiplier for the given shift.
   * All preference multipliers are multiplied together.
   * e.g. PREFERS_MORNING + weight 3 → multiplier 0.85
   */
  getPreferenceMultiplier(shiftStart: Date): number {
    if (this.preferences.length === 0) return 1.0;
    return this.preferences.reduce(
      (acc, pref) => acc * pref.getCostMultiplier(shiftStart),
      1.0,
    );
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  get phone(): string {
    return this.phoneNumber.value;
  }

  get experienceMonths(): number {
    return this.experience.months;
  }

  get experienceLevel(): 'junior' | 'intermediate' | 'senior' {
    return this.experience.level;
  }
}

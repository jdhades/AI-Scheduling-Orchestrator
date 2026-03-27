export class ExperienceLevel {
  constructor(
    public readonly months: number,
    private readonly companyRanges: {
      junior: number;
      intermediate: number;
      senior: number;
    },
  ) {
    if (months < 0) throw new Error('Experience cannot be negative');
  }

  isJunior() {
    return this.months < this.companyRanges.junior;
  }
  isIntermediate() {
    return (
      this.months >= this.companyRanges.junior &&
      this.months < this.companyRanges.intermediate
    );
  }
  isSenior() {
    return this.months >= this.companyRanges.intermediate;
  }

  get level(): 'junior' | 'intermediate' | 'senior' {
    if (this.isJunior()) return 'junior';
    if (this.isIntermediate()) return 'intermediate';
    return 'senior';
  }
}

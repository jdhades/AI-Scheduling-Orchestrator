import type { WorkingTimePolicyOverrides } from '../value-objects/working-time-policy.vo';

export class Department {
  constructor(
    public readonly id: string,
    public readonly branchId: string,
    public readonly companyId: string,
    public readonly name: string,
    public readonly workingTimeOverrides: WorkingTimePolicyOverrides = {},
    public readonly createdAt: Date = new Date(),
  ) {}

  static create(props: {
    id: string;
    branchId: string;
    companyId: string;
    name: string;
    workingTimeOverrides?: WorkingTimePolicyOverrides;
  }): Department {
    return new Department(
      props.id,
      props.branchId,
      props.companyId,
      props.name,
      props.workingTimeOverrides ?? {},
    );
  }
}

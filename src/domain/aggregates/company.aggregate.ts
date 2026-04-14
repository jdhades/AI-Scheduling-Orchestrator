import { AggregateRoot } from '@nestjs/cqrs';
import { CompanySkill } from '../aggregates/company-skill.aggregate';
import { FairnessPolicy } from '../policies/fairness.policy';
import type { WorkingTimePolicyOverrides } from '../value-objects/working-time-policy.vo';

export class Company extends AggregateRoot {
  private skills: CompanySkill[] = [];
  private policies: FairnessPolicy[] = [];

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly workingTimeDefaults: WorkingTimePolicyOverrides = {},
  ) {
    super();
  }

  addSkill(skill: CompanySkill) {
    this.skills.push(skill);
  }

  addPolicy(policy: FairnessPolicy) {
    this.policies.push(policy);
  }

  getSkills() {
    return [...this.skills];
  }

  getPolicies() {
    return [...this.policies];
  }
}

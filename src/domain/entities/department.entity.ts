export class Department {
  constructor(
    public readonly id: string,
    public readonly branchId: string,
    public readonly companyId: string,
    public readonly name: string,
    public readonly createdAt: Date = new Date(),
  ) {}

  static create(props: {
    id: string;
    branchId: string;
    companyId: string;
    name: string;
  }): Department {
    return new Department(
      props.id,
      props.branchId,
      props.companyId,
      props.name,
    );
  }
}

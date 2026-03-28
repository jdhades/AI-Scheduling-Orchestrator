export class Branch {
  constructor(
    public readonly id: string,
    public readonly companyId: string,
    public readonly name: string,
    public readonly timezone: string = 'UTC',
    public readonly createdAt: Date = new Date(),
  ) {}

  static create(props: {
    id: string;
    companyId: string;
    name: string;
    timezone?: string;
  }): Branch {
    return new Branch(
      props.id,
      props.companyId,
      props.name,
      props.timezone ?? 'UTC',
    );
  }
}

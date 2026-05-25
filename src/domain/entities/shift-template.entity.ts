export class ShiftTemplate {
  constructor(
    public readonly id: string,
    public readonly departmentId: string,
    public readonly name: string,
    public readonly timeStart: string, // e.g. "08:00:00"
    public readonly timeEnd: string, // e.g. "16:00:00"
    public readonly createdAt: Date = new Date(),
  ) {}

  static create(props: {
    id: string;
    departmentId: string;
    name: string;
    timeStart: string;
    timeEnd: string;
  }): ShiftTemplate {
    return new ShiftTemplate(
      props.id,
      props.departmentId,
      props.name,
      props.timeStart,
      props.timeEnd,
    );
  }
}

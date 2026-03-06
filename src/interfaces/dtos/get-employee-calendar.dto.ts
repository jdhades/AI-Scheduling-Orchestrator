import { IsDateString } from 'class-validator';

export class GetEmployeeCalendarDto {
    @IsDateString()
    from: string;

    @IsDateString()
    to: string;
}

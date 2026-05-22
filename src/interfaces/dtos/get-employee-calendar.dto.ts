import { IsDateString, IsOptional, IsString } from 'class-validator';

export class GetEmployeeCalendarDto {
  @IsDateString()
  from: string;

  @IsDateString()
  to: string;

  // El interceptor del frontend inyecta `companyId` en TODAS las requests
  // no-/admin para mantener compat con endpoints legacy. Lo aceptamos como
  // opcional pasivo (lo ignoramos — la company real sale del JWT via
  // @CurrentCompany). Sin esto, el ValidationPipe global rechaza con
  // "property companyId should not exist".
  @IsOptional()
  @IsString()
  companyId?: string;
}

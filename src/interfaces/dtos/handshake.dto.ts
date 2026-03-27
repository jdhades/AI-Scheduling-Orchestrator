import { IsString, IsNotEmpty, IsUUID, IsNumber, Min } from 'class-validator';

export class InitiateHandshakeDto {
  @IsUUID('4')
  handshakeId: string;

  @IsString()
  @IsNotEmpty()
  phone: string;
}

export class VerifyHandshakeDto {
  @IsUUID('4')
  token: string;
}

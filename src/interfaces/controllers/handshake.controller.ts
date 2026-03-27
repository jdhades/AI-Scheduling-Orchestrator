import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Headers,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { InitiateHandshakeCommand } from '../../application/commands/initiate-handshake.command';
import { VerifyHandshakeCommand } from '../../application/commands/verify-handshake.command';
import { HandshakeToken } from '../../domain/value-objects/handshake-token.vo';
import {
  InitiateHandshakeDto,
  VerifyHandshakeDto,
} from '../dtos/handshake.dto';

/**
 * HandshakeController — Interfaces Layer
 *
 * Expone los endpoints del UUID Handshake para vincular
 * el número de WhatsApp de un empleado.
 *
 * Flujo:
 *  1. POST /employees/:id/handshake  → genera token y lo "envía" (logging por ahora)
 *  2. POST /employees/:id/verify     → el empleado confirma con su token
 */
@Controller('employees')
export class HandshakeController {
  constructor(private readonly commandBus: CommandBus) {}

  /**
   * POST /employees/:id/handshake
   * Inicia el proceso de vinculación WhatsApp para el empleado.
   * El token TTL es de 15 minutos por defecto.
   */
  @Post(':id/handshake')
  @HttpCode(HttpStatus.ACCEPTED)
  async initiate(
    @Param('id') employeeId: string,
    @Body() dto: InitiateHandshakeDto,
    @Headers('x-company-id') _companyId: string,
  ): Promise<{ message: string }> {
    const token = HandshakeToken.create(dto.handshakeId);

    await this.commandBus.execute(
      new InitiateHandshakeCommand(
        dto.handshakeId,
        employeeId,
        dto.phone,
        token,
      ),
    );

    return { message: 'Handshake initiated. Token sent to WhatsApp.' };
  }

  /**
   * POST /employees/:id/verify
   * El empleado envía el token recibido por WhatsApp para confirmar su número.
   */
  @Post(':id/verify')
  @HttpCode(HttpStatus.OK)
  async verify(
    @Param('id') employeeId: string,
    @Body() dto: VerifyHandshakeDto,
    @Headers('x-company-id') _companyId: string,
  ): Promise<{ message: string }> {
    // handshakeId = employeeId in this simplified flow
    // In production, the client would send the handshakeId explicitly
    await this.commandBus.execute(
      new VerifyHandshakeCommand(employeeId, dto.token),
    );

    return { message: 'WhatsApp number verified successfully.' };
  }
}

import { CommandHandler, EventPublisher, ICommandHandler } from '@nestjs/cqrs';
import { Inject, NotFoundException } from '@nestjs/common';
import { VerifyHandshakeCommand } from '../commands/verify-handshake.command';
import { WhatsappHandshake } from '../../domain/aggregates/whatsapp-handshake.aggregate';
import { HandshakeToken } from '../../domain/value-objects/handshake-token.vo';
import { HANDSHAKE_REPOSITORY } from '../../domain/repositories/handshake.repository';
import type { IHandshakeRepository } from '../../domain/repositories/handshake.repository';

/**
 * Handler: VerifyHandshakeHandler
 *
 * Orquesta la verificación del token enviado por el empleado vía WhatsApp:
 *  1. Recupera los datos del handshake desde la DB
 *  2. Reconstituye el aggregate (fromPersistence) — sin disparar eventos
 *  3. Llama a verify() — el dominio aplica todas las reglas de negocio:
 *     - token debe coincidir exactamente
 *     - token no debe estar expirado
 *     - handshake no debe estar ya verificado
 *  4. Si válido: aplica HandshakeVerifiedEvent → commit()
 *  5. HandshakeVerifiedHandler reacciona → marca whatsapp_verified = true
 *
 * 💡 El handler no conoce las reglas. Si el aggregate lanza un Error,
 *    se propaga naturalmente (token inválido, expirado, doble verificación).
 */
@CommandHandler(VerifyHandshakeCommand)
export class VerifyHandshakeHandler implements ICommandHandler<VerifyHandshakeCommand> {
  constructor(
    private readonly publisher: EventPublisher,
    @Inject(HANDSHAKE_REPOSITORY)
    private readonly handshakeRepository: IHandshakeRepository,
  ) {}

  async execute(command: VerifyHandshakeCommand): Promise<void> {
    const { handshakeId, providedToken } = command;

    const data = await this.handshakeRepository.findById(handshakeId);
    if (!data) {
      throw new NotFoundException(`Handshake ${handshakeId} not found`);
    }

    // Reconstituye el aggregate desde DB — el token se recrea con un TTL
    // fijo de 0 ya que la expiración la controlamos con la fecha de DB
    const token = HandshakeToken.create(data.token, 0);
    // Sobrescribimos expiresAt con el valor real de la DB usando Object.assign
    // ya que HandshakeToken es inmutable por diseño
    const persistedToken = Object.assign(
      Object.create(Object.getPrototypeOf(token)),
      { value: data.token, expiresAt: data.expiresAt },
    ) as HandshakeToken;

    const handshake = this.publisher.mergeObjectContext(
      WhatsappHandshake.fromPersistence({
        id: handshakeId,
        employeeId: data.employeeId,
        phone: data.phone,
        token: persistedToken,
        verified: data.verified,
      }),
    );

    // Dominio valida las 3 invariantes — lanza Error si falla
    handshake.verify(providedToken);

    await this.handshakeRepository.markVerified(handshakeId);
    handshake.commit();
  }
}

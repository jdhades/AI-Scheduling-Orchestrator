import { CommandHandler, EventPublisher, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { InitiateHandshakeCommand } from '../commands/initiate-handshake.command';
import { WhatsappHandshake } from '../../domain/aggregates/whatsapp-handshake.aggregate';
import { HANDSHAKE_REPOSITORY } from '../../domain/repositories/handshake.repository';
import type { IHandshakeRepository } from '../../domain/repositories/handshake.repository';

@CommandHandler(InitiateHandshakeCommand)
export class InitiateHandshakeHandler
    implements ICommandHandler<InitiateHandshakeCommand> {
    constructor(
        private readonly publisher: EventPublisher,
        @Inject(HANDSHAKE_REPOSITORY)
        private readonly handshakeRepository: IHandshakeRepository,
    ) { }

    async execute(command: InitiateHandshakeCommand): Promise<void> {
        const { handshakeId, employeeId, phone, token } = command;

        const handshake = this.publisher.mergeObjectContext(
            WhatsappHandshake.initiate(handshakeId, employeeId, phone, token),
        );

        await this.handshakeRepository.save(handshake, token.value, token.expiresAt);
        handshake.commit();
    }
}


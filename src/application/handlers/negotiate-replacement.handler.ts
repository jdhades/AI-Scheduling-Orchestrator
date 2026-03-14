import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { NegotiateReplacementCommand } from '../commands/negotiate-replacement.command';
import { Logger, Inject } from '@nestjs/common';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';

@CommandHandler(NegotiateReplacementCommand)
export class NegotiateReplacementHandler
    implements ICommandHandler<NegotiateReplacementCommand> {
    private readonly logger = new Logger(NegotiateReplacementHandler.name);

    constructor(
        @Inject('IEmployeeRepository') private readonly employeeRepository: IEmployeeRepository
    ) { }

    async execute(command: NegotiateReplacementCommand): Promise<void> {
        const { incidentId, candidateEmployeeId, shiftId } = command;

        this.logger.log(`Initiating WhatsApp negotiation for Incident ${incidentId} with Employee ${candidateEmployeeId} for Shift ${shiftId}`);

        // The command also passed companyId
        const candidate = await this.employeeRepository.findById(candidateEmployeeId, command.companyId);

        if (!candidate) {
            this.logger.error(`Candidate ${candidateEmployeeId} not found. Aborting negotiation.`);
            return;
        }

        // 1. Simulation of WhatsApp Notification Delivery (Twilio Service API)
        this.logger.log(`[TWILIO MOCK] Message Sent to ${candidate.id}: "Hola, ¿puedes cubrir el turno ${shiftId} de urgencia hoy? (Responde SÍ o NO)"`);

        // 2. The system now awaits the webhook response from Twilio.
        // When the employee answers "SÍ", the message-router (Scenario 4) will trigger a "ReplacementAssignedEvent".
        // If they say "NO" or timeout, the engine will loop to the next available employee.

        this.logger.log(`Message successfully queued for Twilio Delivery. Waiting for Candidate response...`);
    }
}

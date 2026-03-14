import {
    WebSocketGateway,
    WebSocketServer,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnGatewayInit,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
    cors: {
        origin: '*', // Permitir cualquier origen por ahora para integración local
    },
})
export class NotificationsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
    private readonly logger = new Logger(NotificationsGateway.name);

    @WebSocketServer()
    server: Server;

    afterInit(server: Server) {
        this.logger.log('WebSocket Gateway Initialized');
    }

    handleConnection(client: Socket) {
        this.logger.log(`Client connected: ${client.id}`);
    }

    handleDisconnect(client: Socket) {
        this.logger.log(`Client disconnected: ${client.id}`);
    }

    /**
     * Broadcasts that a new schedule has been successfully generated.
     * Clients should listen to 'ScheduleGenerated' to invalidate their caches.
     */
    notifyScheduleGenerated(companyId: string, weekStart: string) {
        this.server.emit('ScheduleGenerated', { companyId, weekStart });
        this.logger.log(`Broadcasted ScheduleGenerated for company ${companyId}, week ${weekStart}`);
    }

    /**
     * Broadcasts that a new HR routing incident has occurred (e.g., employee absence).
     */
    notifyIncidentCreated(companyId: string, message: string, severity: 'warning' | 'critical') {
        this.server.emit('IncidentCreated', { companyId, message, severity, timestamp: new Date() });
        this.logger.log(`Broadcasted IncidentCreated: [${severity}] ${message}`);
    }
}

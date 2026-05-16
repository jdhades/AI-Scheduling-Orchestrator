import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { NotificationsGateway } from './notifications.gateway';
import { ApprovalsBroadcastInterceptor } from './approvals-broadcast.interceptor';

@Module({
  providers: [
    NotificationsGateway,
    // Global interceptor: emite ApprovalsChanged en mutaciones a las 4
    // entities de approvals. Sin tocar los controllers individuales.
    {
      provide: APP_INTERCEPTOR,
      useClass: ApprovalsBroadcastInterceptor,
    },
  ],
  exports: [NotificationsGateway],
})
export class WebsocketModule {}

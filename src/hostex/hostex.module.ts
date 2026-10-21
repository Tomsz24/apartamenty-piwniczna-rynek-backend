import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { HostexClient } from './hostex.client';
import { HostexController } from './hostex.controller';
import { HostexService } from './hostex.service';
import { HostexSyncService } from './hostex-sync.service';
import { HostexReservationWritesService } from './hostex-reservation-writes.service';
import { HostexWebhookController } from './hostex-webhook.controller';
import { HostexWebhookService } from './hostex-webhook.service';

@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [HostexWebhookController, HostexController],
  providers: [
    HostexClient,
    HostexService,
    HostexSyncService,
    HostexReservationWritesService,
    HostexWebhookService,
  ],
  exports: [HostexClient, HostexService, HostexSyncService, HostexReservationWritesService],
})
export class HostexModule {}

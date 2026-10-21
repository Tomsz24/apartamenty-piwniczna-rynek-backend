import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApnsClient } from './apns.client';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationProducerService } from './notification-producer.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { ReservationEmailService } from './reservation-email.service';

@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    ReservationEmailService,
    ApnsClient,
    NotificationProducerService,
    NotificationDispatchService,
  ],
  exports: [NotificationProducerService],
})
export class NotificationsModule {}

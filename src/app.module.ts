import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { CalendarsModule } from './calendars/calendars.module';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { ReservationsModule } from './reservations/reservations.module';
import { TtlockModule } from './ttlock/ttlock.module';
import { AccessCodesModule } from './access-codes/access-codes.module';
import { HostexModule } from './hostex/hostex.module';
import { ApartmentsModule } from './apartments/apartments.module';
import { NotificationsModule } from './notifications/notifications.module';
import { StatisticsModule } from './statistics/statistics.module';
import { ArrivalMessagesModule } from './arrival-messages/arrival-messages.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    DatabaseModule,
    AuthModule,
    ReservationsModule,
    CalendarsModule,
    ScheduleModule.forRoot(),
    TtlockModule,
    AccessCodesModule,
    HostexModule,
    ApartmentsModule,
    NotificationsModule,
    StatisticsModule,
    ArrivalMessagesModule,
    HealthModule,
  ],
})
export class AppModule {}

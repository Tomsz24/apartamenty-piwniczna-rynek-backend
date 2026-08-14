import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { CalendarsModule } from './calendars/calendars.module';
import { IcalSyncModule } from './ical-sync/ical-sync.module';
import { AuthModule } from './auth/auth.module';
import { ReservationsModule } from './reservations/reservations.module';
import { TtlockModule } from './ttlock/ttlock.module';
import { AccessCodesModule } from './access-codes/access-codes.module';

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
    IcalSyncModule,
    TtlockModule,
    AccessCodesModule,
    HealthModule,
  ],
})
export class AppModule {}

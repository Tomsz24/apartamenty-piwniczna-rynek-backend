import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { CalendarsModule } from './calendars/calendars.module';
import { IcalSyncModule } from './ical-sync/ical-sync.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    DatabaseModule,
    AuthModule,
    CalendarsModule,
    IcalSyncModule,
    HealthModule,
  ],
})
export class AppModule {}

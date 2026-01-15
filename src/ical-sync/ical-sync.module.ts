import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { IcalSyncService } from './ical-sync.service';

@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [IcalSyncService],
  exports: [IcalSyncService],
})
export class IcalSyncModule {}

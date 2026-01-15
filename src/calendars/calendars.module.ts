import { Module } from '@nestjs/common';
import { CalendarsController } from './calendars.controller';
import { CalendarsService } from './calendars.service';
import {IcalSyncModule} from "../ical-sync/ical-sync.module";

@Module({
  imports: [IcalSyncModule],
  controllers: [CalendarsController],
  providers: [CalendarsService],
})
export class CalendarsModule {}

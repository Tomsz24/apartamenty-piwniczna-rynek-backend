import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SupabaseAdminGuard } from '../auth/supabase-admin.guard';
import { GetStatisticsQueryDto } from './statistics.dto';
import { StatisticsService } from './statistics.service';

@Controller('statistics')
@UseGuards(SupabaseAdminGuard)
export class StatisticsController {
  constructor(private readonly statisticsService: StatisticsService) {}

  @Get('summary')
  getSummary(@Query() query: GetStatisticsQueryDto) {
    return this.statisticsService.summary(query);
  }
}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { HostexModule } from '../hostex/hostex.module';
import { StatisticsController } from './statistics.controller';
import { StatisticsService } from './statistics.service';

@Module({
  imports: [AuthModule, HostexModule],
  controllers: [StatisticsController],
  providers: [StatisticsService],
})
export class StatisticsModule {}

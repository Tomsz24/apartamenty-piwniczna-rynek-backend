import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { HostexClient } from './hostex.client';
import { HostexController } from './hostex.controller';
import { HostexService } from './hostex.service';

@Module({
  imports: [AuthModule],
  controllers: [HostexController],
  providers: [HostexClient, HostexService],
  exports: [HostexClient, HostexService],
})
export class HostexModule {}

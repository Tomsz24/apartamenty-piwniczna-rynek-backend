import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TtlockController } from './ttlock.controller';
import { TtlockService } from './ttlock.service';

@Module({
  imports: [AuthModule],
  controllers: [TtlockController],
  providers: [TtlockService],
  exports: [TtlockService],
})
export class TtlockModule {}

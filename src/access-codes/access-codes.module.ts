import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TtlockModule } from '../ttlock/ttlock.module';
import { AccessCodeCryptoService } from './access-code-crypto.service';
import { AccessCodesController } from './access-codes.controller';
import { AccessCodesService } from './access-codes.service';
import { LockMappingsService } from './lock-mappings.service';

@Module({
  imports: [AuthModule, TtlockModule],
  controllers: [AccessCodesController],
  providers: [AccessCodesService, AccessCodeCryptoService, LockMappingsService],
  exports: [AccessCodesService],
})
export class AccessCodesModule {}

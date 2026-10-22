import { Module } from '@nestjs/common';
import { AccessCodesModule } from '../access-codes/access-codes.module';
import { AuthModule } from '../auth/auth.module';
import { HostexModule } from '../hostex/hostex.module';
import { ArrivalMessagesController } from './arrival-messages.controller';
import { ArrivalMessagesService } from './arrival-messages.service';

@Module({
  imports: [AuthModule, AccessCodesModule, HostexModule],
  controllers: [ArrivalMessagesController],
  providers: [ArrivalMessagesService],
})
export class ArrivalMessagesModule {}

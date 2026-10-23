import { Module } from '@nestjs/common';
import { AccessCodesModule } from '../access-codes/access-codes.module';
import { AuthModule } from '../auth/auth.module';
import { HostexModule } from '../hostex/hostex.module';
import { ArrivalMessagesController } from './arrival-messages.controller';
import { ArrivalMessagesService } from './arrival-messages.service';
import { ArrivalTemplatesController } from './arrival-templates.controller';

@Module({
  imports: [AuthModule, AccessCodesModule, HostexModule],
  controllers: [ArrivalMessagesController, ArrivalTemplatesController],
  providers: [ArrivalMessagesService],
})
export class ArrivalMessagesModule {}

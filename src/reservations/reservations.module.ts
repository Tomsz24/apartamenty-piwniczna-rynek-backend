import { Module } from '@nestjs/common';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';
import { AuthModule } from '../auth/auth.module';
import { HostexModule } from '../hostex/hostex.module';

@Module({
  imports: [AuthModule, HostexModule],
  controllers: [ReservationsController],
  providers: [ReservationsService],
  exports: [ReservationsService],
})
export class ReservationsModule {}

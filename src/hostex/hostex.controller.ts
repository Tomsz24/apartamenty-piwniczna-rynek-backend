import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SupabaseAdminGuard } from '../auth/supabase-admin.guard';
import {
  ListHostexPropertiesQueryDto,
  ListHostexReservationsQueryDto,
} from './hostex.dto';
import { HostexService } from './hostex.service';
import {
  HostexIntegrationStatus,
  HostexPage,
  HostexPropertySummary,
  HostexReservationSummary,
} from './hostex.types';

@Controller('hostex')
@UseGuards(SupabaseAdminGuard)
export class HostexController {
  constructor(private readonly hostexService: HostexService) {}

  @Get('status')
  getStatus(): HostexIntegrationStatus {
    return this.hostexService.getStatus();
  }

  @Get('properties')
  listProperties(
    @Query() dto: ListHostexPropertiesQueryDto,
  ): Promise<HostexPage<HostexPropertySummary>> {
    return this.hostexService.listProperties({
      offset: dto.offset ?? 0,
      limit: dto.limit ?? 20,
      id: dto.id,
      groupId: dto.groupId,
      tagId: dto.tagId,
    });
  }

  @Get('reservations')
  listReservations(
    @Query() dto: ListHostexReservationsQueryDto,
  ): Promise<HostexPage<HostexReservationSummary>> {
    return this.hostexService.listReservations({
      offset: dto.offset ?? 0,
      limit: dto.limit ?? 20,
      reservationCode: dto.reservationCode,
      channelId: dto.channelId,
      propertyId: dto.propertyId,
      status: dto.status,
      startCheckInDate: dto.startCheckInDate,
      endCheckInDate: dto.endCheckInDate,
      startCheckOutDate: dto.startCheckOutDate,
      endCheckOutDate: dto.endCheckOutDate,
      orderBy: dto.orderBy,
      channelType: dto.channelType,
    });
  }
}

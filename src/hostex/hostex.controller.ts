import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAdminGuard } from '../auth/supabase-admin.guard';
import {
  ListHostexPropertiesQueryDto,
  ListHostexReservationsQueryDto,
  ListHostexConversationsQueryDto,
  SendHostexMessageDto,
} from './hostex.dto';
import { HostexService } from './hostex.service';
import { HostexSyncService } from './hostex-sync.service';
import { HostexWebhookService } from './hostex-webhook.service';
import { SetHostexPropertyMappingDto, SyncHostexReservationsDto } from './hostex-sync.dto';
import {
  HostexIntegrationStatus,
  HostexPage,
  HostexPropertySummary,
  HostexReservationSummary,
  IntegrationConnectionStatus,
} from './hostex.types';

@Controller('hostex')
@UseGuards(SupabaseAdminGuard)
export class HostexController {
  constructor(
    private readonly hostexService: HostexService,
    private readonly hostexSyncService: HostexSyncService,
    private readonly hostexWebhookService: HostexWebhookService,
  ) {}

  @Get('status')
  getStatus(): HostexIntegrationStatus {
    return this.hostexService.getStatus();
  }

  @Get('connection')
  checkConnection(): Promise<IntegrationConnectionStatus> {
    return this.hostexService.checkConnection();
  }

  @Get('mappings')
  listMappings() {
    return this.hostexSyncService.listMappings();
  }

  @Post('properties/:propertyId/mapping')
  setPropertyMapping(
    @Param('propertyId', ParseIntPipe) propertyId: number,
    @Body() dto: SetHostexPropertyMappingDto,
  ) {
    return this.hostexSyncService.setMapping(propertyId, dto.apartmentId);
  }

  @Get('sync/issues')
  listSyncIssues() {
    return this.hostexSyncService.listSyncIssues();
  }

  @Get('sync/status')
  getSyncStatus() {
    return this.hostexSyncService.getAutomaticSyncStatus();
  }

  @Get('webhook/status')
  getWebhookStatus() {
    return this.hostexWebhookService.getStatus();
  }

  @Post('sync/reservations')
  syncReservations(@Body() dto?: SyncHostexReservationsDto) {
    return this.hostexSyncService.syncReservations(dto?.apply === true);
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

  @Post('conversations/:conversationId/messages')
  sendMessage(
    @Param('conversationId') conversationId: string,
    @Body() dto: SendHostexMessageDto,
  ) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(conversationId)) {
      throw new BadRequestException('Nieprawidłowy identyfikator rozmowy Hostex');
    }
    return this.hostexService.sendMessage(conversationId, dto.message);
  }

  @Get('conversations')
  listConversations(@Query() dto: ListHostexConversationsQueryDto) {
    return this.hostexService.listConversations(dto.offset ?? 0, dto.limit ?? 50);
  }

  @Get('conversations/:conversationId')
  getConversation(@Param('conversationId') conversationId: string) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(conversationId)) {
      throw new BadRequestException('Nieprawidłowy identyfikator rozmowy Hostex');
    }
    return this.hostexService.getConversation(conversationId);
  }
}

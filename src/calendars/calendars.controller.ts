import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { CalendarsService } from './calendars.service';
import {
  CalendarsResponseDto,
  CreateBookingDto,
  DeleteExternalBookingNoteDto,
  UpdateBookingDto,
  UpsertExternalBookingNoteDto,
} from './calendars.types';
import { IcalSyncService } from '../ical-sync/ical-sync.service';
import { SupabaseAdminGuard } from '../auth/supabase-admin.guard';
import { ReservationActor } from '../reservations/reservations.types';

type AuthenticatedRequest = { user: ReservationActor };

@Controller('calendars')
export class CalendarsController {
  constructor(
    private readonly calendarsService: CalendarsService,
    private readonly icalSyncService: IcalSyncService,
  ) {}

  @Get()
  async getCalendars(): Promise<CalendarsResponseDto> {
    return this.calendarsService.getAllCalendars();
  }

  @Post('bookings')
  @UseGuards(SupabaseAdminGuard)
  async createBooking(
    @Body() dto: CreateBookingDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.calendarsService.createManualBooking(dto, request.user);
  }

  @Put('bookings/:id')
  @UseGuards(SupabaseAdminGuard)
  async updateBooking(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBookingDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.calendarsService.updateManualBooking(id, dto, request.user);
  }

  @Post('sync')
  @UseGuards(SupabaseAdminGuard)
  async forceSync() {
    return this.icalSyncService.forceSync();
  }

  @Delete('bookings/:id')
  @UseGuards(SupabaseAdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteBooking(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.calendarsService.deleteManualBooking(id, request.user);
  }

  @Put('external-notes')
  @UseGuards(SupabaseAdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async upsertExternalNote(
    @Body() dto: UpsertExternalBookingNoteDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.calendarsService.upsertExternalBookingNote(dto, request.user);
  }

  @Delete('external-notes')
  @UseGuards(SupabaseAdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteExternalNote(@Body() dto: DeleteExternalBookingNoteDto): Promise<void> {
    await this.calendarsService.deleteExternalBookingNote(dto);
  }
}

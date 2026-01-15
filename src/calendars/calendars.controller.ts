import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CalendarsService } from './calendars.service';
import { CalendarsResponseDto, CreateBookingDto, UpdateBookingDto } from './calendars.types';
import { IcalSyncService } from '../ical-sync/ical-sync.service';
import { SupabaseAdminGuard } from '../auth/supabase-admin.guard';

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
  async createBooking(@Body() dto: CreateBookingDto) {
    return this.calendarsService.createManualBooking(dto);
  }

  @Put('bookings/:id')
  @UseGuards(SupabaseAdminGuard)
  async updateBooking(@Param('id') id: string, @Body() dto: UpdateBookingDto) {
    try {
      return await this.calendarsService.updateManualBooking(id, dto);
    } catch {
      throw new NotFoundException('Rezerwacja nie została znaleziona');
    }
  }

  @Post('sync')
  @UseGuards(SupabaseAdminGuard)
  async forceSync() {
    return this.icalSyncService.forceSync();
  }

  @Delete('bookings/:id')
  @UseGuards(SupabaseAdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteBooking(@Param('id') id: string): Promise<void> {
    return this.calendarsService.deleteManualBooking(id);
  }
}

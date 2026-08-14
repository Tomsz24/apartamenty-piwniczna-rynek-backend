import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAdminGuard } from '../auth/supabase-admin.guard';
import {
  CreateReservationDto,
  ListOrphanedNotesQueryDto,
  ListReservationsQueryDto,
  UpdateReservationDto,
} from './reservations.dto';
import { ReservationsService } from './reservations.service';
import { OrphanedReservationNoteDto, ReservationActor, ReservationDto } from './reservations.types';

type AuthenticatedRequest = { user: ReservationActor };

@Controller('reservations')
@UseGuards(SupabaseAdminGuard)
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Get()
  async list(@Query() query: ListReservationsQueryDto): Promise<ReservationDto[]> {
    return this.reservationsService.list(query);
  }

  @Get('orphaned-notes')
  async listOrphanedNotes(
    @Query() query: ListOrphanedNotesQueryDto,
  ): Promise<OrphanedReservationNoteDto[]> {
    return this.reservationsService.listOrphanedNotes(query);
  }

  @Get(':id')
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<ReservationDto> {
    return this.reservationsService.getById(id);
  }

  @Post()
  async create(
    @Body() dto: CreateReservationDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ReservationDto> {
    return this.reservationsService.createManual(dto, request.user);
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReservationDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ReservationDto> {
    return this.reservationsService.update(id, dto, request.user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.reservationsService.cancelManual(id, request.user);
  }

  @Post(':reservationId/orphaned-notes/:noteId/attach')
  async attachOrphanedNote(
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ReservationDto> {
    return this.reservationsService.attachOrphanedNote(reservationId, noteId, request.user);
  }
}

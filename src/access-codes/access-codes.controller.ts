import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAdminGuard } from '../auth/supabase-admin.guard';
import { ReservationActor } from '../reservations/reservations.types';
import {
  CreateAccessCodeDto,
  AccessCodesOverviewQueryDto,
  CreateReplacementDraftDto,
  ApplyAccessCodeDraftDto,
  DeleteAccessCodeQueryDto,
  ListAccessCodesQueryDto,
  UpdateAccessCodeDto,
} from './access-codes.dto';
import { AccessCodesService } from './access-codes.service';
import {
  AccessCodeDto,
  AccessCodeDraftDto,
  AccessCodePageDto,
  ApplyAccessCodeDraftResultDto,
  AccessCodesStatusDto,
  AccessCodeUsageDto,
  AccessCodesOverviewDto,
} from './access-codes.types';

type AuthenticatedRequest = { user: ReservationActor };

@Controller('access-codes')
@UseGuards(SupabaseAdminGuard)
export class AccessCodesController {
  constructor(private readonly accessCodesService: AccessCodesService) {}

  @Get('status')
  getStatus(): AccessCodesStatusDto {
    return this.accessCodesService.getStatus();
  }

  @Get()
  list(@Query() query: ListAccessCodesQueryDto): Promise<AccessCodePageDto> {
    return this.accessCodesService.list(query);
  }

  @Get('history')
  history(@Query() query: ListAccessCodesQueryDto): Promise<AccessCodePageDto> {
    return this.accessCodesService.list(query);
  }

  @Get('overview')
  overview(
    @Query() query: AccessCodesOverviewQueryDto,
  ): Promise<AccessCodesOverviewDto> {
    return this.accessCodesService.getOverview(query);
  }

  @Post('drafts')
  createDraft(
    @Body() dto: CreateAccessCodeDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<AccessCodeDraftDto> {
    return this.accessCodesService.createDraft(dto, request.user);
  }

  @Put('by-reservation/:reservationId')
  ensureForReservation(
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<AccessCodeDto> {
    return this.accessCodesService.ensureForReservation(reservationId, request.user);
  }

  @Get('drafts/:draftId')
  getDraft(
    @Param('draftId', ParseUUIDPipe) draftId: string,
  ): Promise<AccessCodeDraftDto> {
    return this.accessCodesService.getDraft(draftId);
  }

  @Get('drafts/by-reservation/:reservationId')
  getDraftForReservation(
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
  ): Promise<AccessCodeDraftDto> {
    return this.accessCodesService.getOpenDraftForReservation(reservationId);
  }

  @Post('drafts/:draftId/apply')
  applyDraft(
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @Body() dto: ApplyAccessCodeDraftDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ApplyAccessCodeDraftResultDto> {
    return this.accessCodesService.applyDraft(draftId, dto, request.user);
  }

  @Delete('drafts/:draftId')
  cancelDraft(
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @Query() query: ApplyAccessCodeDraftDto,
  ): Promise<AccessCodeDraftDto> {
    return this.accessCodesService.cancelDraft(draftId, query.expectedDraftVersion);
  }

  @Get(':id')
  getById(@Param('id', ParseUUIDPipe) id: string): Promise<AccessCodeDto> {
    return this.accessCodesService.getById(id);
  }

  @Post(':id/replacement-draft')
  createReplacementDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateReplacementDraftDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<AccessCodeDraftDto> {
    return this.accessCodesService.createReplacementDraft(id, dto, request.user);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAccessCodeDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<AccessCodeDto> {
    return this.accessCodesService.update(id, dto, request.user);
  }

  @Delete(':id')
  revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DeleteAccessCodeQueryDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<AccessCodeDto> {
    return this.accessCodesService.revoke(id, query.expectedVersion, request.user);
  }

  @Get(':id/usage')
  getUsage(@Param('id', ParseUUIDPipe) id: string): Promise<AccessCodeUsageDto> {
    return this.accessCodesService.getUsage(id);
  }

  @Post(':id/usage/refresh')
  refreshUsage(@Param('id', ParseUUIDPipe) id: string): Promise<AccessCodeUsageDto> {
    return this.accessCodesService.refreshUsage(id);
  }
}

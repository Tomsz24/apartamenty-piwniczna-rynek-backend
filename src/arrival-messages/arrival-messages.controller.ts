import { Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { SupabaseAdminGuard } from '../auth/supabase-admin.guard';
import { ReservationActor } from '../reservations/reservations.types';
import { ArrivalMessagePreview, ArrivalMessagesService } from './arrival-messages.service';

type AuthenticatedRequest = { user: ReservationActor };

@Controller('reservations/:id/arrival-message')
@UseGuards(SupabaseAdminGuard)
export class ArrivalMessagesController {
  constructor(private readonly arrivalMessages: ArrivalMessagesService) {}

  /** Rendered message (with the door code), map URL and how it will be delivered. */
  @Get()
  preview(@Param('id', ParseUUIDPipe) id: string): Promise<ArrivalMessagePreview> {
    return this.arrivalMessages.preview(id);
  }

  /** "Send now" through the Hostex chat, before the 10:00 schedule. */
  @Post('send')
  send(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ArrivalMessagePreview> {
    return this.arrivalMessages.sendViaHostex(id, `admin:${request.user.email ?? request.user.id}`);
  }
}

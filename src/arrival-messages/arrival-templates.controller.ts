import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { SupabaseAdminGuard } from '../auth/supabase-admin.guard';
import { ARRIVAL_TEMPLATE_MAX_LENGTH } from './arrival-message.domain';
import { ArrivalMessagesService, ArrivalTemplate } from './arrival-messages.service';

export class SaveArrivalTemplateDto {
  @IsString()
  @MaxLength(ARRIVAL_TEMPLATE_MAX_LENGTH + 100)
  body: string;
}

/** The arrival message text per apartment, editable from the app. */
@Controller('apartments/:apartmentId/arrival-template')
@UseGuards(SupabaseAdminGuard)
export class ArrivalTemplatesController {
  constructor(private readonly arrivalMessages: ArrivalMessagesService) {}

  @Get()
  get(@Param('apartmentId', ParseUUIDPipe) apartmentId: string): Promise<ArrivalTemplate> {
    return this.arrivalMessages.getTemplate(apartmentId);
  }

  @Put()
  save(
    @Param('apartmentId', ParseUUIDPipe) apartmentId: string,
    @Body() dto: SaveArrivalTemplateDto,
  ): Promise<ArrivalTemplate> {
    return this.arrivalMessages.saveTemplate(apartmentId, dto.body);
  }
}

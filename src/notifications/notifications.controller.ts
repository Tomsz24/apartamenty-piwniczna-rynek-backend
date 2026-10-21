import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { SupabaseAdminGuard } from '../auth/supabase-admin.guard';
import {
  NotificationDeviceTokenDto,
  RegisterNotificationDeviceDto,
  UpdateNotificationPreferencesDto,
} from './notifications.dto';
import { AdminIdentity, NotificationsService } from './notifications.service';
import { NotificationDispatchService } from './notification-dispatch.service';

@Controller('notifications')
@UseGuards(SupabaseAdminGuard)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  @Get('push/status')
  getPushStatus() {
    return this.dispatch.getStatus();
  }

  @Get('inbox')
  getInbox(@Req() request: any) {
    return this.notifications.getInbox(this.adminFrom(request));
  }

  @Put('inbox/:id/read')
  markInboxItemRead(@Req() request: any, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.notifications.markInboxItemRead(this.adminFrom(request), id);
  }

  @Put('inbox/read-all')
  markAllInboxRead(@Req() request: any) {
    return this.notifications.markAllInboxRead(this.adminFrom(request));
  }

  @Post('devices')
  registerDevice(@Req() request: any, @Body() dto: RegisterNotificationDeviceDto) {
    return this.notifications.registerDevice(this.adminFrom(request), dto);
  }

  @Delete('devices')
  unregisterDevice(@Req() request: any, @Body() dto: NotificationDeviceTokenDto) {
    return this.notifications.unregisterDevice(this.adminFrom(request), dto);
  }

  @Get('preferences')
  getPreferences(@Req() request: any) {
    return this.notifications.getPreferences(this.adminFrom(request));
  }

  @Put('preferences')
  updatePreferences(
    @Req() request: any,
    @Body() dto: UpdateNotificationPreferencesDto,
  ) {
    return this.notifications.updatePreferences(this.adminFrom(request), dto);
  }

  private adminFrom(request: any): AdminIdentity {
    return { id: request.user.id, email: request.user.email };
  }
}

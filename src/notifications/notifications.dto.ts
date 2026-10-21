import { IsBoolean, IsIn, IsString, Matches, MaxLength } from 'class-validator';

export class RegisterNotificationDeviceDto {
  @IsString()
  @Matches(/^[A-Fa-f0-9]{64}$/)
  deviceToken!: string;

  @IsIn(['sandbox', 'production'])
  environment!: 'sandbox' | 'production';

  @IsString()
  @MaxLength(200)
  appId!: string;
}

export class NotificationDeviceTokenDto {
  @IsString()
  @Matches(/^[A-Fa-f0-9]{64}$/)
  deviceToken!: string;

  @IsIn(['sandbox', 'production'])
  environment!: 'sandbox' | 'production';
}

export class UpdateNotificationPreferencesDto {
  @IsBoolean() newReservations!: boolean;
  @IsBoolean() newMessages!: boolean;
  @IsBoolean() reservationUpdates!: boolean;
  @IsBoolean() cancellations!: boolean;
  @IsBoolean() accessCodeErrors!: boolean;
  @IsBoolean() arrivalMessageReminder!: boolean;
}

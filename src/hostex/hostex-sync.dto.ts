import { IsBoolean, IsUUID } from 'class-validator';

export class SetHostexPropertyMappingDto {
  @IsUUID()
  apartmentId!: string;
}

export class SyncHostexReservationsDto {
  @IsBoolean()
  apply = false;
}

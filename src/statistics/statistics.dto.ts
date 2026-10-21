import { IsOptional, IsUUID, Matches } from 'class-validator';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export class GetStatisticsQueryDto {
  @IsOptional()
  @Matches(datePattern)
  from?: string;

  @IsOptional()
  @Matches(datePattern)
  to?: string;

  @IsOptional()
  @IsUUID()
  apartmentId?: string;
}

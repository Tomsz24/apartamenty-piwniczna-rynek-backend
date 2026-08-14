import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ACCESS_CODE_STATUSES, AccessCodeStatus } from './access-codes.types';

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateAccessCodeDto {
  @IsUUID()
  reservationId: string;

  @IsISO8601({ strict: true })
  validFrom: string;

  @IsISO8601({ strict: true })
  validUntil: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(100)
  name?: string;
}

export class UpdateAccessCodeDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  validFrom?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  validUntil?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion: number;
}

export class CreateReplacementDraftDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  validFrom?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  validUntil?: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(100)
  name?: string | null;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion: number;
}

export class ApplyAccessCodeDraftDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedDraftVersion: number;
}

export class ListAccessCodesQueryDto {
  @IsOptional()
  @IsUUID()
  apartmentId?: string;

  @IsOptional()
  @IsUUID()
  reservationId?: string;

  @IsOptional()
  @IsIn([...ACCESS_CODE_STATUSES, 'expired'])
  status?: AccessCodeStatus | 'expired';

  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class DeleteAccessCodeQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion: number;
}

export class AccessCodesOverviewQueryDto {
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value;
  })
  @IsBoolean()
  includeStatistics?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(180)
  statisticsDays?: number;
}

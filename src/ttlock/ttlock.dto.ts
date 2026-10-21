import { Type } from 'class-transformer';
import {
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class PreviewTtlockPasscodeDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  lockId: number;

  @IsString()
  @Matches(/^\d{4}$/, {
    message: 'passcode musi składać się dokładnie z 4 cyfr',
  })
  passcode: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsISO8601({ strict: true })
  startAt: string;

  @IsISO8601({ strict: true })
  endAt: string;
}

export class CreateDiagnosticTtlockPasscodeDto {
  @IsString()
  @Matches(/^\d{4}$/, {
    message: 'passcode musi składać się dokładnie z 4 cyfr',
  })
  passcode: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsISO8601({ strict: true })
  startAt: string;

  @IsISO8601({ strict: true })
  endAt: string;
}

export class UpdateDiagnosticTtlockPasscodeDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}$/, {
    message: 'newPasscode musi składać się dokładnie z 4 cyfr',
  })
  newPasscode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string | null;

  @IsOptional()
  @IsISO8601({ strict: true })
  startAt?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  endAt?: string;
}

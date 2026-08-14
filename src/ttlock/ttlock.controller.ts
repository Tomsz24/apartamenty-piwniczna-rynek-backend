import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAdminGuard } from '../auth/supabase-admin.guard';
import {
  CreateDiagnosticTtlockPasscodeDto,
  PreviewTtlockPasscodeDto,
  UpdateDiagnosticTtlockPasscodeDto,
} from './ttlock.dto';
import { TtlockService } from './ttlock.service';
import {
  TtlockGatewaySummary,
  TtlockIntegrationStatus,
  TtlockLockSummary,
  TtlockPasscodeCapabilities,
  TtlockDiagnosticPasscodeWriteResult,
  TtlockPasscodeMetadata,
  TtlockPasscodePreview,
} from './ttlock.types';

@Controller('ttlock')
@UseGuards(SupabaseAdminGuard)
export class TtlockController {
  constructor(private readonly ttlockService: TtlockService) {}

  @Get('status')
  getStatus(): TtlockIntegrationStatus {
    return this.ttlockService.getStatus();
  }

  @Get('locks')
  listLocks(): Promise<TtlockLockSummary[]> {
    return this.ttlockService.listLocks();
  }

  @Get('gateways')
  listGateways(): Promise<TtlockGatewaySummary[]> {
    return this.ttlockService.listGateways();
  }

  @Get('passcode-capabilities')
  getPasscodeCapabilities(): Promise<TtlockPasscodeCapabilities[]> {
    return this.ttlockService.getPasscodeCapabilities();
  }

  @Get('locks/:lockId/passcodes')
  listPasscodes(
    @Param('lockId', ParseIntPipe) lockId: number,
  ): Promise<TtlockPasscodeMetadata[]> {
    return this.ttlockService.listPasscodes(lockId);
  }

  @Post('passcodes/preview')
  previewPasscode(
    @Body() dto: PreviewTtlockPasscodeDto,
  ): Promise<TtlockPasscodePreview> {
    return this.ttlockService.previewPasscode(dto);
  }

  @Post('diagnostic/locks/:lockId/passcodes')
  async createDiagnosticPasscode(
    @Param('lockId', ParseIntPipe) lockId: number,
    @Body() dto: CreateDiagnosticTtlockPasscodeDto,
  ): Promise<TtlockDiagnosticPasscodeWriteResult> {
    await this.ttlockService.previewPasscode({ lockId, ...dto });
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    const result = await this.ttlockService.createPasscode({
      lockId,
      passcode: dto.passcode,
      name: dto.name?.trim() || null,
      startAt,
      endAt,
    });
    return {
      action: 'created',
      writeExecuted: true,
      databaseWriteExecuted: false,
      lockId,
      keyboardPwdId: result.keyboardPwdId,
      name: dto.name?.trim() || null,
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
    };
  }

  @Patch('diagnostic/locks/:lockId/passcodes/:keyboardPwdId')
  async updateDiagnosticPasscode(
    @Param('lockId', ParseIntPipe) lockId: number,
    @Param('keyboardPwdId', ParseIntPipe) keyboardPwdId: number,
    @Body() dto: UpdateDiagnosticTtlockPasscodeDto,
  ): Promise<TtlockDiagnosticPasscodeWriteResult> {
    const startAt = dto.startAt ? new Date(dto.startAt) : undefined;
    const endAt = dto.endAt ? new Date(dto.endAt) : undefined;
    await this.ttlockService.changePasscode({
      lockId,
      keyboardPwdId,
      newPasscode: dto.newPasscode,
      name: dto.name,
      startAt,
      endAt,
    });
    return {
      action: 'updated',
      writeExecuted: true,
      databaseWriteExecuted: false,
      lockId,
      keyboardPwdId,
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(startAt && endAt
        ? { startAt: startAt.toISOString(), endAt: endAt.toISOString() }
        : {}),
    };
  }

  @Delete('diagnostic/locks/:lockId/passcodes/:keyboardPwdId')
  async deleteDiagnosticPasscode(
    @Param('lockId', ParseIntPipe) lockId: number,
    @Param('keyboardPwdId', ParseIntPipe) keyboardPwdId: number,
  ): Promise<TtlockDiagnosticPasscodeWriteResult> {
    await this.ttlockService.deletePasscode(lockId, keyboardPwdId);
    return {
      action: 'deleted',
      writeExecuted: true,
      databaseWriteExecuted: false,
      lockId,
      keyboardPwdId,
    };
  }
}

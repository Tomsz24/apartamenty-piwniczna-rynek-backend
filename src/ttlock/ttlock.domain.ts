import {
  TtlockGatewaySummary,
  TtlockLockSummary,
  TtlockPasscodeMetadata,
} from './ttlock.types';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readList(payload: unknown): unknown[] {
  const record = asRecord(payload);
  return record && Array.isArray(record.list) ? record.list : [];
}

export function readTtlockErrorCode(payload: unknown): number | null {
  const record = asRecord(payload);
  return record ? asNumber(record.errcode) : null;
}

export function sanitizeLockList(payload: unknown): TtlockLockSummary[] {
  return readList(payload)
    .map(asRecord)
    .filter((record): record is UnknownRecord => record !== null)
    .map((record) => ({
      lockId: asNumber(record.lockId),
      name: asString(record.lockName),
      alias: asString(record.lockAlias),
      initializedAt: asNumber(record.date),
      batteryPercentage: asNumber(record.electricQuantity),
      keyboardPwdVersion: asNumber(record.keyboardPwdVersion),
      specialValue: asNumber(record.specialValue),
      hasGateway: asNumber(record.hasGateway) === 1,
      groupId: asNumber(record.groupId),
      groupName: asString(record.groupName),
    }))
    .filter((lock): lock is TtlockLockSummary => lock.lockId !== null);
}

export function sanitizeGatewayList(payload: unknown): TtlockGatewaySummary[] {
  return readList(payload)
    .map(asRecord)
    .filter((record): record is UnknownRecord => record !== null)
    .map((record) => ({
      gatewayId: asNumber(record.gatewayId),
      version: asNumber(record.gatewayVersion),
      lockCount: asNumber(record.lockNum),
      online: asNumber(record.isOnline) === 1,
    }))
    .filter((gateway): gateway is TtlockGatewaySummary => gateway.gatewayId !== null);
}

export function sanitizePasscodeList(payload: unknown): TtlockPasscodeMetadata[] {
  return readList(payload)
    .map(asRecord)
    .filter((record): record is UnknownRecord => record !== null)
    .map((record) => {
      const passcode = asString(record.keyboardPwd);
      return {
        keyboardPwdId: asNumber(record.keyboardPwdId),
        lockId: asNumber(record.lockId),
        name: asString(record.keyboardPwdName),
        codeLength: passcode ? passcode.length : null,
        type: asNumber(record.keyboardPwdType),
        startAt: asNumber(record.startDate),
        endAt: asNumber(record.endDate),
        createdAt: asNumber(record.sendDate),
        custom: asNumber(record.isCustom) === 1,
        status: asNumber(record.status),
      };
    })
    .filter(
      (passcode): passcode is TtlockPasscodeMetadata =>
        passcode.keyboardPwdId !== null && passcode.lockId !== null,
    );
}

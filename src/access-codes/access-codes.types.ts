export const ACCESS_CODE_STATUSES = [
  'pending_create',
  'active',
  'pending_update',
  'pending_delete',
  'revoked',
  'sync_error',
] as const;

export type AccessCodeStatus = (typeof ACCESS_CODE_STATUSES)[number];
export type AccessCodeDisplayStatus = AccessCodeStatus | 'expired';

export type AccessDeviceReferenceDto = {
  id: string;
  provider: 'ttlock';
  lockId: number;
  displayName: string | null;
};

export type AccessCodeDto = {
  id: string;
  reservationId: string;
  apartmentId: string;
  apartmentName: string;
  accessDevice: AccessDeviceReferenceDto;
  guestName: string | null;
  stayStartDate: string;
  stayEndDate: string;
  code: string;
  name: string | null;
  validFrom: string;
  validUntil: string;
  validitySource: 'apartment_default' | 'manual_override' | 'manual_draft' | 'unknown';
  timeZone: string;
  status: AccessCodeDisplayStatus;
  providerPasscodeId: number | null;
  usageCount: number | null;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
  usageSyncedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type AccessCodePageDto = {
  items: AccessCodeDto[];
  nextCursor: string | null;
};

export type AccessCodeUsageDto = {
  accessCodeId: string;
  usageCount: number;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
  events: Array<{ usedAt: string; receivedAt: string | null }>;
  complete: boolean;
};

export type AccessCodesStatusDto = {
  encryptionConfigured: boolean;
  ttlockWritesEnabled: boolean;
  writeMode: 'blocked' | 'controlled_test';
};

export type AccessCodeDraftAction = 'create' | 'replace';
export type AccessCodeDraftStatus =
  | 'draft'
  | 'applying'
  | 'applied'
  | 'cancelled'
  | 'sync_error'
  | 'expired';

export type AccessCodeDraftDto = {
  id: string;
  action: AccessCodeDraftAction;
  accessCodeId: string | null;
  appliedAccessCodeId: string | null;
  reservationId: string;
  apartmentId: string;
  apartmentName: string;
  accessDevice: AccessDeviceReferenceDto;
  guestName: string | null;
  code: string;
  name: string | null;
  validFrom: string;
  validUntil: string;
  status: AccessCodeDraftStatus;
  expiresAt: string;
  lastError: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ApplyAccessCodeDraftResultDto = {
  draft: AccessCodeDraftDto;
  accessCode: AccessCodeDto | null;
};

export type AccessCodeOverviewStatisticsDto = {
  recordsScanned: number;
  successfulUnlocks: number;
  successfulPasscodeUnlocks: number;
  invalidPasscodeAttempts: number;
  lastActivityAt: string | null;
  complete: boolean;
};

export type AccessCodeOverviewLockDto = {
  lockId: number;
  name: string | null;
  alias: string | null;
  batteryPercentage: number | null;
  batteryLevel: 'good' | 'low' | 'critical' | 'unknown';
  hasGateway: boolean;
  keyboardPwdVersion: number | null;
  mapping: {
    accessDeviceId: string;
    displayName: string | null;
    scope: 'apartment' | 'shared_entrance';
    apartmentId: string | null;
    apartmentName: string | null;
  } | null;
  codeCounts: {
    current: number;
    upcoming: number;
    syncErrors: number;
  };
  statistics: AccessCodeOverviewStatisticsDto | null;
};

export type AccessCodesOverviewDto = {
  generatedAt: string;
  batterySource: 'ttlock_cloud';
  gateways: {
    total: number;
    online: number;
    offline: number;
  };
  statisticsRange: {
    from: string;
    to: string;
    requestedDays: number;
    providerRetentionGuaranteed: false;
  } | null;
  locks: AccessCodeOverviewLockDto[];
};

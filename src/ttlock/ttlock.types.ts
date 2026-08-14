export type TtlockIntegrationStatus = {
  enabled: boolean;
  ready: boolean;
  mode: 'read_only' | 'read_write';
  writesEnabled: boolean;
  clientConfigured: boolean;
  accountCredentialsConfigured: boolean;
  accessTokenConfigured: boolean;
  refreshTokenConfigured: boolean;
  tokenCached: boolean;
};

export type TtlockCreatePasscodeParams = {
  lockId: number;
  passcode: string;
  name: string | null;
  startAt: Date;
  endAt: Date;
};

export type TtlockChangePasscodeParams = {
  lockId: number;
  keyboardPwdId: number;
  newPasscode?: string;
  name?: string | null;
  startAt?: Date;
  endAt?: Date;
};

export type TtlockPasscodeWriteResult = {
  keyboardPwdId: number;
};

export type TtlockPasscodeUsageEvent = {
  usedAt: string;
  receivedAt: string | null;
};

export type TtlockPasscodeUsage = {
  usageCount: number;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
  events: TtlockPasscodeUsageEvent[];
  complete: boolean;
};

export type TtlockLockStatistics = {
  recordsScanned: number;
  successfulUnlocks: number;
  successfulPasscodeUnlocks: number;
  invalidPasscodeAttempts: number;
  lastActivityAt: string | null;
  complete: boolean;
};

export type TtlockLockSummary = {
  lockId: number;
  name: string | null;
  alias: string | null;
  initializedAt: number | null;
  batteryPercentage: number | null;
  keyboardPwdVersion: number | null;
  specialValue: number | null;
  hasGateway: boolean;
  groupId: number | null;
  groupName: string | null;
};

export type TtlockGatewaySummary = {
  gatewayId: number;
  version: number | null;
  lockCount: number | null;
  online: boolean;
};

export type TtlockPasscodeMetadata = {
  keyboardPwdId: number;
  lockId: number;
  name: string | null;
  codeLength: number | null;
  type: number | null;
  startAt: number | null;
  endAt: number | null;
  createdAt: number | null;
  custom: boolean;
  status: number | null;
};

export type TtlockPasscodeCapabilities = {
  lockId: number;
  lockName: string | null;
  lockAlias: string | null;
  keyboardPwdVersion: number | null;
  hasGateway: boolean;
  customPasscodesSupported: boolean;
  gatewayWriteSupported: boolean;
  minimumDigits: 4;
  maximumDigits: 4;
};

export type TtlockPasscodePreview = {
  valid: true;
  writeExecuted: false;
  lockId: number;
  lockName: string | null;
  lockAlias: string | null;
  passcodeLength: number;
  name: string | null;
  startAt: string;
  endAt: string;
  addType: 2;
};

export type TtlockDiagnosticPasscodeWriteResult = {
  action: 'created' | 'updated' | 'deleted';
  writeExecuted: true;
  databaseWriteExecuted: false;
  lockId: number;
  keyboardPwdId: number;
  name?: string | null;
  startAt?: string;
  endAt?: string;
};

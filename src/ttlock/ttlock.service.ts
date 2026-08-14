import {
  BadRequestException,
  BadGatewayException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  readTtlockErrorCode,
  sanitizeGatewayList,
  sanitizeLockList,
  sanitizePasscodeList,
} from './ttlock.domain';
import { PreviewTtlockPasscodeDto } from './ttlock.dto';
import {
  TtlockGatewaySummary,
  TtlockChangePasscodeParams,
  TtlockCreatePasscodeParams,
  TtlockIntegrationStatus,
  TtlockLockSummary,
  TtlockLockStatistics,
  TtlockPasscodeCapabilities,
  TtlockPasscodeMetadata,
  TtlockPasscodePreview,
  TtlockPasscodeUsage,
  TtlockPasscodeWriteResult,
} from './ttlock.types';

type UnknownRecord = Record<string, unknown>;

type TokenSession = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
};

@Injectable()
export class TtlockService {
  private readonly logger = new Logger(TtlockService.name);
  private readonly enabled: boolean;
  private readonly apiBaseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly writesEnabled: boolean;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly accountUsername: string;
  private readonly accountPasswordMd5: string;
  private refreshToken: string;
  private tokenSession: TokenSession | null = null;
  private tokenRequest: Promise<TokenSession> | null = null;

  constructor(private readonly configService: ConfigService) {
    this.enabled = this.readBoolean(this.configService.get<string>('TTLOCK_ENABLED'), false);
    this.apiBaseUrl = this.normalizeBaseUrl(
      this.configService.get<string>('TTLOCK_API_BASE_URL') || 'https://api.sciener.com',
    );
    this.requestTimeoutMs = this.readPositiveInteger(
      this.configService.get<string>('TTLOCK_REQUEST_TIMEOUT_MS'),
      10_000,
    );
    this.writesEnabled = this.readBoolean(
      this.configService.get<string>('TTLOCK_WRITES_ENABLED'),
      false,
    );
    this.clientId = this.readSecret('TTLOCK_CLIENT_ID');
    this.clientSecret = this.readSecret('TTLOCK_CLIENT_SECRET');
    this.accountUsername = this.readSecret('TTLOCK_ACCOUNT_USERNAME');
    this.accountPasswordMd5 = this.readSecret('TTLOCK_ACCOUNT_PASSWORD_MD5').toLowerCase();
    this.refreshToken = this.readSecret('TTLOCK_REFRESH_TOKEN');

    const accessToken = this.readSecret('TTLOCK_ACCESS_TOKEN');
    if (accessToken) {
      this.tokenSession = {
        accessToken,
        refreshToken: this.refreshToken || null,
        expiresAt: Number.POSITIVE_INFINITY,
      };
    }
  }

  getStatus(): TtlockIntegrationStatus {
    const clientConfigured = Boolean(this.clientId && this.clientSecret);
    const accountCredentialsConfigured = Boolean(
      this.accountUsername && this.accountPasswordMd5,
    );
    const accessTokenConfigured = Boolean(this.configService.get<string>('TTLOCK_ACCESS_TOKEN'));
    const refreshTokenConfigured = Boolean(this.refreshToken);

    return {
      enabled: this.enabled,
      ready:
        this.enabled &&
        clientConfigured &&
        (accountCredentialsConfigured || accessTokenConfigured || refreshTokenConfigured),
      mode: this.writesEnabled ? 'read_write' : 'read_only',
      writesEnabled: this.writesEnabled,
      clientConfigured,
      accountCredentialsConfigured,
      accessTokenConfigured,
      refreshTokenConfigured,
      tokenCached: this.tokenSession !== null,
    };
  }

  async listLocks(): Promise<TtlockLockSummary[]> {
    this.assertReady();
    const payload = await this.authorizedRequest('/v3/lock/list', {
      pageNo: '1',
      pageSize: '100',
      type: '1',
    });
    return sanitizeLockList(payload);
  }

  async listGateways(): Promise<TtlockGatewaySummary[]> {
    this.assertReady();
    const payload = await this.authorizedRequest('/v3/gateway/list', {
      pageNo: '1',
      pageSize: '100',
    });
    return sanitizeGatewayList(payload);
  }

  async listPasscodes(lockId: number): Promise<TtlockPasscodeMetadata[]> {
    this.assertReady();
    const records = await this.listAllPages('/v3/lock/listKeyboardPwd', {
      lockId: lockId.toString(),
    });
    return sanitizePasscodeList({ list: records });
  }

  async getPasscodeCapabilities(): Promise<TtlockPasscodeCapabilities[]> {
    const locks = await this.listLocks();
    return locks.map((lock) => ({
      lockId: lock.lockId,
      lockName: lock.name,
      lockAlias: lock.alias,
      keyboardPwdVersion: lock.keyboardPwdVersion,
      hasGateway: lock.hasGateway,
      customPasscodesSupported: lock.keyboardPwdVersion === 4,
      gatewayWriteSupported: lock.keyboardPwdVersion === 4 && lock.hasGateway,
      minimumDigits: 4,
      maximumDigits: 4,
    }));
  }

  async previewPasscode(dto: PreviewTtlockPasscodeDto): Promise<TtlockPasscodePreview> {
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    if (endAt.getTime() <= startAt.getTime()) {
      throw new BadRequestException('endAt musi być późniejsze niż startAt');
    }

    const locks = await this.listLocks();
    const lock = locks.find((candidate) => candidate.lockId === dto.lockId);
    if (!lock) {
      throw new NotFoundException('Zamek nie należy do autoryzowanego konta TTLock');
    }
    if (lock.keyboardPwdVersion !== 4) {
      throw new BadRequestException('Zamek nie obsługuje własnych kodów V4');
    }
    if (!lock.hasGateway) {
      throw new BadRequestException('Zamek nie jest połączony z bramką TTLock');
    }

    return {
      valid: true,
      writeExecuted: false,
      lockId: lock.lockId,
      lockName: lock.name,
      lockAlias: lock.alias,
      passcodeLength: dto.passcode.length,
      name: dto.name?.trim() || null,
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      addType: 2,
    };
  }

  assertWritesAllowed(): void {
    this.assertReady();
    if (!this.writesEnabled) {
      throw new ServiceUnavailableException(
        'Zapisy TTLock są zablokowane. Włącz TTLOCK_WRITES_ENABLED dopiero na czas kontrolowanego testu.',
      );
    }
  }

  async isPasscodeAvailable(params: {
    lockId: number;
    passcode: string;
    startAt: Date;
    endAt: Date;
  }): Promise<boolean> {
    this.assertFourDigitPasscode(params.passcode);
    this.assertTimestampRange(params.startAt, params.endAt);
    const records = await this.listAllPages('/v3/lock/listKeyboardPwd', {
      lockId: params.lockId.toString(),
    });

    return !records.some((record) => {
      const code = this.asNonEmptyString(record.keyboardPwd);
      const startAt = this.asPositiveNumber(record.startDate);
      const endAt = this.asPositiveNumber(record.endDate);
      if (code !== params.passcode || !startAt || !endAt) return false;
      return startAt < params.endAt.getTime() && endAt > params.startAt.getTime();
    });
  }

  async isPasscodeConfigured(params: {
    lockId: number;
    keyboardPwdId: number;
    passcode: string;
    startAt: Date;
    endAt: Date;
  }): Promise<boolean> {
    this.assertFourDigitPasscode(params.passcode);
    this.assertTimestampRange(params.startAt, params.endAt);
    const records = await this.listAllPages('/v3/lock/listKeyboardPwd', {
      lockId: params.lockId.toString(),
    });
    return records.some((record) => {
      const keyboardPwdId = this.asPositiveNumber(record.keyboardPwdId);
      const passcode = this.asNonEmptyString(record.keyboardPwd);
      const startAt = this.asPositiveNumber(record.startDate);
      const endAt = this.asPositiveNumber(record.endDate);
      return (
        keyboardPwdId === params.keyboardPwdId &&
        passcode === params.passcode &&
        startAt !== null &&
        endAt !== null &&
        Math.abs(startAt - params.startAt.getTime()) <= 1_000 &&
        Math.abs(endAt - params.endAt.getTime()) <= 1_000
      );
    });
  }

  async createPasscode(
    params: TtlockCreatePasscodeParams,
  ): Promise<TtlockPasscodeWriteResult> {
    this.assertWritesAllowed();
    this.assertFourDigitPasscode(params.passcode);
    this.assertTimestampRange(params.startAt, params.endAt);
    const payload = await this.authorizedRequest('/v3/keyboardPwd/add', {
      lockId: params.lockId.toString(),
      keyboardPwd: params.passcode,
      ...(params.name ? { keyboardPwdName: params.name } : {}),
      startDate: params.startAt.getTime().toString(),
      endDate: params.endAt.getTime().toString(),
      addType: '2',
    });
    const keyboardPwdId = this.asPositiveNumber(this.asRecord(payload)?.keyboardPwdId);
    if (!keyboardPwdId) {
      throw new BadGatewayException('TTLock nie zwrócił identyfikatora utworzonego kodu');
    }
    return { keyboardPwdId };
  }

  async changePasscode(params: TtlockChangePasscodeParams): Promise<void> {
    this.assertWritesAllowed();
    if (params.newPasscode !== undefined) this.assertFourDigitPasscode(params.newPasscode);
    if ((params.startAt && !params.endAt) || (!params.startAt && params.endAt)) {
      throw new BadRequestException('startAt i endAt muszą zostać zmienione razem');
    }
    if (params.startAt && params.endAt) {
      this.assertTimestampRange(params.startAt, params.endAt);
    }
    if (
      params.newPasscode === undefined &&
      params.name === undefined &&
      params.startAt === undefined
    ) {
      throw new BadRequestException('Nie przekazano żadnych zmian kodu TTLock');
    }

    await this.authorizedRequest('/v3/keyboardPwd/change', {
      lockId: params.lockId.toString(),
      keyboardPwdId: params.keyboardPwdId.toString(),
      ...(params.newPasscode !== undefined ? { newKeyboardPwd: params.newPasscode } : {}),
      ...(params.name !== undefined ? { keyboardPwdName: params.name ?? '' } : {}),
      ...(params.startAt && params.endAt
        ? {
            startDate: params.startAt.getTime().toString(),
            endDate: params.endAt.getTime().toString(),
          }
        : {}),
      changeType: '2',
    });
  }

  async deletePasscode(lockId: number, keyboardPwdId: number): Promise<void> {
    this.assertWritesAllowed();
    await this.authorizedRequest('/v3/keyboardPwd/delete', {
      lockId: lockId.toString(),
      keyboardPwdId: keyboardPwdId.toString(),
      deleteType: '2',
    });
  }

  async getPasscodeUsage(params: {
    lockId: number;
    passcode: string;
    startAt: Date;
    endAt: Date;
  }): Promise<TtlockPasscodeUsage> {
    this.assertFourDigitPasscode(params.passcode);
    this.assertTimestampRange(params.startAt, params.endAt);
    const records = await this.listAllPages(
      '/v3/lockRecord/list',
      {
        lockId: params.lockId.toString(),
        startDate: params.startAt.getTime().toString(),
        endDate: params.endAt.getTime().toString(),
      },
      20,
    );

    const events = records
      .filter(
        (record) =>
          this.asPositiveNumber(record.recordType) === 4 &&
          this.asPositiveNumber(record.success) === 1 &&
          this.asNonEmptyString(record.keyboardPwd) === params.passcode,
      )
      .map((record) => {
        const lockDate = this.asPositiveNumber(record.lockDate);
        const serverDate = this.asPositiveNumber(record.serverDate);
        return lockDate
          ? {
              usedAt: new Date(lockDate).toISOString(),
              receivedAt: serverDate ? new Date(serverDate).toISOString() : null,
            }
          : null;
      })
      .filter((event): event is { usedAt: string; receivedAt: string | null } => event !== null)
      .sort((left, right) => left.usedAt.localeCompare(right.usedAt));

    return {
      usageCount: events.length,
      firstUsedAt: events[0]?.usedAt ?? null,
      lastUsedAt: events.at(-1)?.usedAt ?? null,
      events,
      complete: records.length < 2_000,
    };
  }

  async getLockStatistics(params: {
    lockId: number;
    startAt: Date;
    endAt: Date;
  }): Promise<TtlockLockStatistics> {
    this.assertTimestampRange(params.startAt, params.endAt);
    const records = await this.listAllPages(
      '/v3/lockRecord/list',
      {
        lockId: params.lockId.toString(),
        startDate: params.startAt.getTime().toString(),
        endDate: params.endAt.getTime().toString(),
      },
      20,
    );
    const successfulUnlockTypes = new Set([1, 3, 4, 7, 8, 9, 10, 11, 12, 32, 46]);
    let successfulUnlocks = 0;
    let successfulPasscodeUnlocks = 0;
    let invalidPasscodeAttempts = 0;
    let lastActivityAt: string | null = null;

    for (const record of records) {
      const type = this.asPositiveNumber(record.recordType);
      const success = this.asPositiveNumber(record.success);
      if (type !== null && successfulUnlockTypes.has(type) && success === 1) {
        successfulUnlocks += 1;
      }
      if (type === 4 && success === 1) successfulPasscodeUnlocks += 1;
      if (type === 48) invalidPasscodeAttempts += 1;

      const lockDate = this.asPositiveNumber(record.lockDate);
      if (lockDate) {
        const timestamp = new Date(lockDate).toISOString();
        if (!lastActivityAt || timestamp > lastActivityAt) lastActivityAt = timestamp;
      }
    }

    return {
      recordsScanned: records.length,
      successfulUnlocks,
      successfulPasscodeUnlocks,
      invalidPasscodeAttempts,
      lastActivityAt,
      complete: records.length < 2_000,
    };
  }

  private async listAllPages(
    path: string,
    fields: Record<string, string>,
    maximumPages = 100,
  ): Promise<UnknownRecord[]> {
    const records: UnknownRecord[] = [];

    for (let pageNo = 1; pageNo <= maximumPages; pageNo++) {
      const payload = await this.authorizedRequest(path, {
        ...fields,
        pageNo: pageNo.toString(),
        pageSize: '100',
      });
      const payloadRecord = this.asRecord(payload);
      const pageRecords = Array.isArray(payloadRecord?.list)
        ? payloadRecord.list
            .map((item) => this.asRecord(item))
            .filter((item): item is UnknownRecord => item !== null)
        : [];
      records.push(...pageRecords);

      const pages = this.asPositiveNumber(payloadRecord?.pages);
      if ((pages && pageNo >= pages) || pageRecords.length < 100) break;
    }

    return records;
  }

  private assertFourDigitPasscode(passcode: string): void {
    if (!/^\d{4}$/.test(passcode)) {
      throw new BadRequestException('Kod TTLock musi składać się dokładnie z 4 cyfr');
    }
  }

  private assertTimestampRange(startAt: Date, endAt: Date): void {
    if (
      Number.isNaN(startAt.getTime()) ||
      Number.isNaN(endAt.getTime()) ||
      endAt.getTime() <= startAt.getTime()
    ) {
      throw new BadRequestException('Koniec ważności kodu musi być późniejszy niż początek');
    }
  }

  private assertReady(): void {
    const status = this.getStatus();
    if (!status.enabled) {
      throw new ServiceUnavailableException('Integracja TTLock jest wyłączona');
    }
    if (!status.clientConfigured) {
      throw new ServiceUnavailableException('Brakuje konfiguracji aplikacji TTLock');
    }
    if (!status.ready) {
      throw new ServiceUnavailableException(
        'Brakuje tokenu albo danych konta właściciela TTLock',
      );
    }
    if (
      this.accountPasswordMd5 &&
      !/^[a-f0-9]{32}$/.test(this.accountPasswordMd5)
    ) {
      throw new ServiceUnavailableException(
        'TTLOCK_ACCOUNT_PASSWORD_MD5 musi być 32-znakowym hashem MD5',
      );
    }
  }

  private async authorizedRequest(
    path: string,
    fields: Record<string, string>,
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const accessToken = await this.getAccessToken();
      const payload = await this.postForm(path, {
        clientId: this.clientId,
        accessToken,
        date: Date.now().toString(),
        ...fields,
      });

      const errorCode = readTtlockErrorCode(payload);
      if (attempt === 0 && (errorCode === 10003 || errorCode === 10004)) {
        this.logger.warn(`TTLock odrzucił token (kod ${errorCode}); ponawiam autoryzację`);
        this.tokenSession = null;
        continue;
      }

      this.assertApiSuccess(payload, path);
      return payload;
    }

    throw new BadGatewayException('Nie udało się autoryzować żądania TTLock');
  }

  private async getAccessToken(): Promise<string> {
    if (this.tokenSession && this.tokenSession.expiresAt > Date.now() + 60_000) {
      return this.tokenSession.accessToken;
    }

    if (!this.tokenRequest) {
      this.tokenRequest = this.acquireToken().finally(() => {
        this.tokenRequest = null;
      });
    }

    this.tokenSession = await this.tokenRequest;
    return this.tokenSession.accessToken;
  }

  private async acquireToken(): Promise<TokenSession> {
    if (this.refreshToken) {
      try {
        return await this.requestToken({
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken,
        });
      } catch (error) {
        if (!this.accountUsername || !this.accountPasswordMd5) throw error;
        this.logger.warn('Odświeżenie tokenu TTLock nie powiodło się; używam konta właściciela');
        this.refreshToken = '';
      }
    }

    if (!this.accountUsername || !this.accountPasswordMd5) {
      throw new ServiceUnavailableException(
        'Brakuje ważnego refresh tokenu albo danych konta właściciela TTLock',
      );
    }

    return this.requestToken({
      username: this.accountUsername,
      password: this.accountPasswordMd5,
    });
  }

  private async requestToken(fields: Record<string, string>): Promise<TokenSession> {
    const payload = await this.postForm('/oauth2/token', {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      ...fields,
    });
    this.assertApiSuccess(payload, '/oauth2/token');

    const record = this.asRecord(payload);
    const accessToken = this.asNonEmptyString(record?.access_token);
    const refreshToken = this.asNonEmptyString(record?.refresh_token);
    const expiresIn = this.asPositiveNumber(record?.expires_in);

    if (!accessToken || !expiresIn) {
      throw new BadGatewayException('TTLock zwrócił niepełną odpowiedź autoryzacji');
    }

    this.refreshToken = refreshToken || this.refreshToken;
    return {
      accessToken,
      refreshToken: refreshToken || null,
      expiresAt: Date.now() + Math.max(expiresIn - 60, 1) * 1_000,
    };
  }

  private async postForm(path: string, fields: Record<string, string>): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;

    try {
      response = await fetch(`${this.apiBaseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new GatewayTimeoutException('TTLock nie odpowiedział w wymaganym czasie');
      }
      throw new BadGatewayException('Nie udało się połączyć z TTLock');
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      this.logger.warn(`TTLock odpowiedział HTTP ${response.status} dla ${path}`);
      throw new BadGatewayException(`TTLock odpowiedział HTTP ${response.status}`);
    }

    try {
      return JSON.parse(await response.text()) as unknown;
    } catch {
      throw new BadGatewayException('TTLock zwrócił nieprawidłowy JSON');
    }
  }

  private assertApiSuccess(payload: unknown, operation: string): void {
    const code = readTtlockErrorCode(payload);
    if (code === null || code === 0) return;

    const messages: Record<number, string> = {
      10000: 'Nieprawidłowy TTLOCK_CLIENT_ID',
      10001: 'Nieprawidłowy klient lub sekret aplikacji TTLock',
      10003: 'Token TTLock nie istnieje',
      10004: 'Token TTLock wygasł albo został unieważniony',
      10006: 'Aplikacja TTLock nie ma dostępu dla tego konta',
      10007: 'Nieprawidłowe konto lub hasło TTLock',
      10011: 'Nieprawidłowy refresh token TTLock',
      30001: 'Aplikacja TTLock nie ma uprawnień do tej operacji',
      30006: 'Przekroczono limit zapytań TTLock',
      80000: 'Zegar serwera różni się od czasu TTLock o więcej niż pięć minut',
      90000: 'Wewnętrzny błąd TTLock',
    };
    this.logger.warn(`TTLock zwrócił kod ${code} dla ${operation}`);
    throw new BadGatewayException(messages[code] || `TTLock odrzucił operację (kod ${code})`);
  }

  private readSecret(name: string): string {
    return (this.configService.get<string>(name) || '').trim();
  }

  private readBoolean(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined || value.trim() === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }

  private readPositiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private normalizeBaseUrl(value: string): string {
    return value.replace(/\/+$/, '');
  }

  private asRecord(value: unknown): UnknownRecord | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as UnknownRecord;
  }

  private asNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
  }

  private asPositiveNumber(value: unknown): number | null {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
}

import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HostexIntegrationStatus,
  HostexPropertiesQuery,
  HostexReservationsQuery,
} from './hostex.types';

type UnknownRecord = Record<string, unknown>;

@Injectable()
export class HostexClient {
  private readonly logger = new Logger(HostexClient.name);
  private readonly enabled: boolean;
  private readonly apiBaseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly readRetryCount: number;
  private readonly retryBaseDelayMs: number;
  private readonly accessToken: string;
  private readonly userAgent: string;

  constructor(private readonly configService: ConfigService) {
    this.enabled = this.readBoolean(this.configService.get<string>('HOSTEX_ENABLED'), false);
    this.apiBaseUrl = this.normalizeBaseUrl(
      this.configService.get<string>('HOSTEX_API_BASE_URL') || 'https://api.hostex.io/v3',
    );
    this.requestTimeoutMs = this.readPositiveInteger(
      this.configService.get<string>('HOSTEX_REQUEST_TIMEOUT_MS'),
      10_000,
    );
    this.readRetryCount = this.readNonNegativeInteger(
      this.configService.get<string>('HOSTEX_READ_RETRY_COUNT'),
      1,
      2,
    );
    this.retryBaseDelayMs = this.readPositiveInteger(
      this.configService.get<string>('HOSTEX_RETRY_BASE_DELAY_MS'),
      250,
    );
    this.accessToken = this.readSecret('HOSTEX_ACCESS_TOKEN');
    this.userAgent =
      (this.configService.get<string>('HOSTEX_USER_AGENT') || '').trim() ||
      'ApartamentyPiwnicznaBackend/1.0';
  }

  getStatus(): HostexIntegrationStatus {
    const accessTokenConfigured = Boolean(this.accessToken);
    return {
      enabled: this.enabled,
      ready: this.enabled && accessTokenConfigured,
      mode: 'read_only',
      writesEnabled: false,
      accessTokenConfigured,
      apiBaseUrlConfigured: Boolean(this.apiBaseUrl),
    };
  }

  getProperties(query: HostexPropertiesQuery): Promise<unknown> {
    return this.get('/properties', {
      offset: query.offset,
      limit: query.limit,
      id: query.id,
      group_id: query.groupId,
      tag_id: query.tagId,
    });
  }

  getReservations(query: HostexReservationsQuery): Promise<unknown> {
    return this.get('/reservations', {
      offset: query.offset,
      limit: query.limit,
      reservation_code: query.reservationCode,
      channel_id: query.channelId,
      property_id: query.propertyId,
      status: query.status,
      start_check_in_date: query.startCheckInDate,
      end_check_in_date: query.endCheckInDate,
      start_check_out_date: query.startCheckOutDate,
      end_check_out_date: query.endCheckOutDate,
      order_by: query.orderBy,
      channel_type: query.channelType,
    });
  }

  private async get(
    path: string,
    query: Record<string, string | number | undefined>,
  ): Promise<unknown> {
    this.assertReady();
    const url = new URL(`${this.apiBaseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }

    for (let attempt = 0; attempt <= this.readRetryCount; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      let response: Response;

      try {
        response = await fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'Hostex-Access-Token': this.accessToken,
            'User-Agent': this.userAgent,
          },
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timeout);
        if (attempt < this.readRetryCount) {
          await this.waitBeforeRetry(attempt);
          continue;
        }
        if (error instanceof Error && error.name === 'AbortError') {
          throw new GatewayTimeoutException('Hostex nie odpowiedział w wymaganym czasie');
        }
        throw new BadGatewayException('Nie udało się połączyć z Hostex');
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        if (response.status >= 500 && attempt < this.readRetryCount) {
          await this.waitBeforeRetry(attempt);
          continue;
        }
        this.logger.warn(`Hostex odpowiedział HTTP ${response.status} dla ${path}`);
        throw new BadGatewayException(`Hostex odpowiedział HTTP ${response.status}`);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(await response.text()) as unknown;
      } catch {
        throw new BadGatewayException('Hostex zwrócił nieprawidłowy JSON');
      }

      const envelope = this.asRecord(payload);
      const errorCode = this.asInteger(envelope?.error_code);
      if (!envelope || errorCode === null) {
        throw new BadGatewayException('Hostex zwrócił nieprawidłową odpowiedź');
      }
      // Aktualna dokumentacja Hostex opisuje sukces jako 0, ale prawdziwe
      // access tokeny hostów zwracają także 200 z komunikatem "Done.".
      if (errorCode === 0 || errorCode === 200) return envelope.data;

      const requestId = this.asNonEmptyString(envelope.request_id);
      if (this.isRetryableProviderCode(errorCode) && attempt < this.readRetryCount) {
        this.logger.warn(
          `Hostex zwrócił przejściowy kod ${errorCode} dla ${path}${
            requestId ? ` (requestId ${requestId})` : ''
          }; ponawiam odczyt`,
        );
        await this.waitBeforeRetry(attempt);
        continue;
      }

      this.throwProviderError(errorCode, requestId);
    }

    throw new BadGatewayException('Nie udało się zakończyć odczytu Hostex');
  }

  private assertReady(): void {
    if (!this.enabled) {
      throw new ServiceUnavailableException(
        'Integracja Hostex jest wyłączona. Ustaw HOSTEX_ENABLED=true po dodaniu tokenu tylko do odczytu.',
      );
    }
    if (!this.accessToken) {
      throw new ServiceUnavailableException('Brakuje HOSTEX_ACCESS_TOKEN');
    }
  }

  private throwProviderError(errorCode: number, requestId: string | null): never {
    const supportReference = requestId ? ` (requestId: ${requestId})` : '';
    this.logger.warn(`Hostex odrzucił odczyt kodem ${errorCode}${supportReference}`);

    if (errorCode === 400 || errorCode === 422) {
      throw new BadRequestException(`Hostex odrzucił parametry odczytu${supportReference}`);
    }
    if (errorCode === 404) {
      throw new NotFoundException(`Hostex nie znalazł zasobu${supportReference}`);
    }
    if (errorCode === 401) {
      throw new ServiceUnavailableException(
        `Token Hostex jest nieprawidłowy, usunięty albo nie ma wymaganego zakresu${supportReference}`,
      );
    }
    if (errorCode === 420) {
      throw new ServiceUnavailableException(
        `Plan lub stan konta Hostex nie pozwala użyć OpenAPI${supportReference}`,
      );
    }
    if (errorCode === 429) {
      throw new ServiceUnavailableException(
        `Hostex tymczasowo ograniczył liczbę zapytań${supportReference}`,
      );
    }
    throw new BadGatewayException(`Hostex odrzucił odczyt kodem ${errorCode}${supportReference}`);
  }

  private isRetryableProviderCode(code: number): boolean {
    return [500, 502, 503, 504].includes(code);
  }

  private async waitBeforeRetry(attempt: number): Promise<void> {
    const delayMs = this.retryBaseDelayMs * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
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

  private readNonNegativeInteger(
    value: string | undefined,
    fallback: number,
    maximum: number,
  ): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= maximum ? parsed : fallback;
  }

  private normalizeBaseUrl(value: string): string {
    return value.replace(/\/+$/, '');
  }

  private asRecord(value: unknown): UnknownRecord | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as UnknownRecord;
  }

  private asNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private asInteger(value: unknown): number | null {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  }
}

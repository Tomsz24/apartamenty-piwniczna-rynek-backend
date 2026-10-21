import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import { connect, ClientHttp2Session, constants } from 'http2';
import { importPKCS8, SignJWT } from 'jose';

export type ApnsEnvironment = 'sandbox' | 'production';

export type ApnsSendResult = {
  status: number;
  reason: string | null;
  apnsId: string | null;
};

const HOSTS: Record<ApnsEnvironment, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};
// Apple rejects provider tokens older than an hour and throttles refreshes
// more often than every 20 minutes.
const TOKEN_TTL_MS = 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

@Injectable()
export class ApnsClient implements OnModuleDestroy {
  private readonly logger = new Logger(ApnsClient.name);
  private readonly keyId: string;
  private readonly teamId: string;
  private readonly bundleId: string;
  private readonly privateKeyPem: string;
  private token: { value: string; createdAt: number } | null = null;
  private readonly sessions = new Map<ApnsEnvironment, ClientHttp2Session>();

  constructor(configService: ConfigService) {
    this.keyId = configService.get<string>('APNS_KEY_ID')?.trim() ?? '';
    this.teamId = configService.get<string>('APNS_TEAM_ID')?.trim() ?? '';
    this.bundleId = configService.get<string>('APNS_BUNDLE_ID')?.trim() || 'Tomsz24.apartamenty-piwniczna-rynek';
    this.privateKeyPem = this.loadPrivateKey(
      configService.get<string>('APNS_PRIVATE_KEY'),
      configService.get<string>('APNS_PRIVATE_KEY_PATH'),
    );
  }

  isConfigured(): boolean {
    return Boolean(this.keyId && this.teamId && this.bundleId && this.privateKeyPem);
  }

  getStatus() {
    return {
      configured: this.isConfigured(),
      keyIdConfigured: Boolean(this.keyId),
      teamIdConfigured: Boolean(this.teamId),
      privateKeyConfigured: Boolean(this.privateKeyPem),
      bundleId: this.bundleId,
    };
  }

  async send(
    environment: ApnsEnvironment,
    deviceToken: string,
    payload: Record<string, unknown>,
    options: { collapseId?: string; expiresAt?: Date } = {},
  ): Promise<ApnsSendResult> {
    if (!/^[0-9a-f]{64}$/i.test(deviceToken)) {
      return { status: 400, reason: 'BadDeviceToken', apnsId: null };
    }
    const token = await this.providerToken();
    const session = this.session(environment);
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      [constants.HTTP2_HEADER_METHOD]: 'POST',
      [constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken.toLowerCase()}`,
      authorization: `bearer ${token}`,
      'apns-topic': this.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    };
    if (options.collapseId) headers['apns-collapse-id'] = options.collapseId.slice(0, 64);
    if (options.expiresAt) {
      headers['apns-expiration'] = String(Math.floor(options.expiresAt.getTime() / 1000));
    }

    return new Promise<ApnsSendResult>((resolve, reject) => {
      const request = session.request(headers);
      let status = 0;
      let apnsId: string | null = null;
      let responseBody = '';
      request.setTimeout(REQUEST_TIMEOUT_MS, () => {
        request.close(constants.NGHTTP2_CANCEL);
        reject(new Error('APNs nie odpowiedział w wymaganym czasie'));
      });
      request.on('response', (responseHeaders) => {
        status = Number(responseHeaders[constants.HTTP2_HEADER_STATUS]);
        const id = responseHeaders['apns-id'];
        apnsId = typeof id === 'string' ? id : null;
      });
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        if (responseBody.length < 4096) responseBody += chunk;
      });
      request.on('end', () => {
        if (status === 403 && this.parseReason(responseBody) === 'ExpiredProviderToken') {
          this.token = null;
        }
        resolve({ status, reason: this.parseReason(responseBody), apnsId });
      });
      request.on('error', (error) => {
        this.dropSession(environment);
        reject(error);
      });
      request.end(body);
    });
  }

  onModuleDestroy(): void {
    for (const environment of [...this.sessions.keys()]) this.dropSession(environment);
  }

  private async providerToken(): Promise<string> {
    if (this.token && Date.now() - this.token.createdAt < TOKEN_TTL_MS) return this.token.value;
    const key = await importPKCS8(this.privateKeyPem, 'ES256');
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.keyId })
      .setIssuer(this.teamId)
      .setIssuedAt()
      .sign(key);
    this.token = { value, createdAt: Date.now() };
    return value;
  }

  private session(environment: ApnsEnvironment): ClientHttp2Session {
    const existing = this.sessions.get(environment);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect(HOSTS[environment]);
    session.on('error', (error) => {
      this.logger.warn(`Połączenie APNs (${environment}) przerwane: ${error.message}`);
      this.dropSession(environment);
    });
    session.on('goaway', () => this.dropSession(environment));
    // Do not keep the process alive just for an idle APNs connection.
    session.unref();
    this.sessions.set(environment, session);
    return session;
  }

  private dropSession(environment: ApnsEnvironment): void {
    const session = this.sessions.get(environment);
    this.sessions.delete(environment);
    if (session && !session.destroyed) session.destroy();
  }

  private parseReason(body: string): string | null {
    if (!body) return null;
    try {
      const reason = (JSON.parse(body) as { reason?: unknown }).reason;
      return typeof reason === 'string' ? reason : null;
    } catch {
      return null;
    }
  }

  private loadPrivateKey(inline: string | undefined, path: string | undefined): string {
    const fromEnv = inline?.trim().replace(/\\n/g, '\n') ?? '';
    if (fromEnv) return fromEnv;
    if (!path?.trim()) return '';
    try {
      return readFileSync(path.trim(), 'utf8').trim();
    } catch (error) {
      this.logger.error(`Nie można odczytać klucza APNs z APNS_PRIVATE_KEY_PATH`);
      return '';
    }
  }
}

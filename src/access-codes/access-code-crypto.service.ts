import {
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

@Injectable()
export class AccessCodeCryptoService {
  private readonly key: Buffer | null;

  constructor(configService: ConfigService) {
    const encoded = (configService.get<string>('ACCESS_CODE_ENCRYPTION_KEY') || '').trim();
    const key = encoded ? Buffer.from(encoded, 'base64') : null;
    this.key = key?.length === 32 ? key : null;
  }

  isConfigured(): boolean {
    return this.key !== null;
  }

  encrypt(code: string): string {
    const key = this.requireKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
  }

  decrypt(value: string): string {
    const key = this.requireKey();
    try {
      const [version, ivValue, tagValue, ciphertextValue] = value.split(':');
      if (version !== 'v1' || !ivValue || !tagValue || !ciphertextValue) {
        throw new Error('invalid encrypted value');
      }
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(ivValue, 'base64url'),
      );
      decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextValue, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new InternalServerErrorException('Nie udało się odszyfrować kodu dostępu');
    }
  }

  fingerprint(code: string): string {
    return createHmac('sha256', this.requireKey()).update(code, 'utf8').digest('hex');
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new ServiceUnavailableException(
        'Brakuje poprawnego ACCESS_CODE_ENCRYPTION_KEY (32 bajty zakodowane base64)',
      );
    }
    return this.key;
  }
}

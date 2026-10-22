import { Injectable } from '@nestjs/common';
import {
  sanitizeHostexConversation,
  sanitizeHostexConversations,
  sanitizeHostexProperties,
  sanitizeHostexReservations,
} from './hostex.domain';
import { HostexClient } from './hostex.client';
import {
  HostexIntegrationStatus,
  HostexPage,
  HostexPropertySummary,
  HostexReservationSummary,
  HostexPropertiesQuery,
  HostexReservationsQuery,
  HostexConversationDetails,
  HostexConversationSummary,
  IntegrationConnectionStatus,
} from './hostex.types';
import { HostexDirectReservationPayload } from './hostex.client';

export type HostexDictionaryItem = { id: number; name: string };

@Injectable()
export class HostexService {
  constructor(private readonly client: HostexClient) {}

  getStatus(): HostexIntegrationStatus {
    return this.client.getStatus();
  }

  async checkConnection(): Promise<IntegrationConnectionStatus> {
    const checkedAt = new Date().toISOString();
    if (!this.client.getStatus().ready) return { connected: false, checkedAt };
    try {
      await this.client.getProperties({ offset: 0, limit: 1 });
      return { connected: true, checkedAt: new Date().toISOString() };
    } catch {
      return { connected: false, checkedAt: new Date().toISOString() };
    }
  }

  sendMessage(conversationId: string, message: string): Promise<{ requestId: string | null }> {
    return this.client.sendMessage(conversationId, message);
  }

  sendImage(conversationId: string, jpegBase64: string): Promise<{ requestId: string | null }> {
    return this.client.sendImage(conversationId, jpegBase64);
  }

  async listConversations(offset: number, limit: number) {
    return sanitizeHostexConversations(await this.client.getConversations(offset, limit), offset, limit);
  }

  async getConversation(conversationId: string): Promise<HostexConversationDetails> {
    return sanitizeHostexConversation(await this.client.getConversation(conversationId), conversationId);
  }

  async listCustomChannels(): Promise<HostexDictionaryItem[]> {
    return this.sanitizeDictionary(await this.client.getCustomChannels(), ['custom_channels', 'channels']);
  }

  async listIncomeMethods(): Promise<HostexDictionaryItem[]> {
    return this.sanitizeDictionary(await this.client.getIncomeMethods(), ['income_methods', 'methods']);
  }

  createDirectReservation(payload: HostexDirectReservationPayload): Promise<unknown> {
    return this.client.createDirectReservation(payload);
  }

  updateDirectReservation(stayCode: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.client.updateDirectReservation(stayCode, payload);
  }

  cancelDirectReservation(reservationCode: string): Promise<unknown> {
    return this.client.cancelDirectReservation(reservationCode);
  }

  async listProperties(
    query: HostexPropertiesQuery,
  ): Promise<HostexPage<HostexPropertySummary>> {
    const data = await this.client.getProperties(query);
    return sanitizeHostexProperties(data, query.offset, query.limit);
  }

  async listReservations(
    query: HostexReservationsQuery,
  ): Promise<HostexPage<HostexReservationSummary>> {
    const data = await this.client.getReservations(query);
    return sanitizeHostexReservations(data, query.offset, query.limit);
  }

  private sanitizeDictionary(data: unknown, candidateKeys: string[]): HostexDictionaryItem[] {
    const record = this.asRecord(data);
    const values = Array.isArray(data)
      ? data
      : candidateKeys.map((key) => record?.[key]).find(Array.isArray) ?? [];
    return values.flatMap((value) => {
      const item = this.asRecord(value);
      const id = Number(item?.id);
      const name = typeof item?.name === 'string' ? item.name.trim() : '';
      return Number.isInteger(id) && id > 0 && name ? [{ id, name }] : [];
    });
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }
}

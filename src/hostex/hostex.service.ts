import { Injectable } from '@nestjs/common';
import { sanitizeHostexProperties, sanitizeHostexReservations } from './hostex.domain';
import { HostexClient } from './hostex.client';
import {
  HostexIntegrationStatus,
  HostexPage,
  HostexPropertySummary,
  HostexReservationSummary,
  HostexPropertiesQuery,
  HostexReservationsQuery,
} from './hostex.types';

@Injectable()
export class HostexService {
  constructor(private readonly client: HostexClient) {}

  getStatus(): HostexIntegrationStatus {
    return this.client.getStatus();
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
}

import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { HostexClient } from '../hostex/hostex.client';
import { sanitizeHostexReservations } from '../hostex/hostex.domain';
import { HostexReservationSummary } from '../hostex/hostex.types';
import { GetStatisticsQueryDto } from './statistics.dto';
import {
  buildStatistics,
  StatisticsApartment,
  StatisticsAvailability,
  StatisticsReview,
  StatisticsStay,
  StatisticsTask,
  StatisticsTransaction,
} from './statistics.domain';

type UnknownRecord = Record<string, unknown>;

@Injectable()
export class StatisticsService {
  private readonly logger = new Logger(StatisticsService.name);

  constructor(
    @Inject('PG_POOL') private readonly pool: Pool,
    private readonly hostexClient: HostexClient,
  ) {}

  async summary(query: GetStatisticsQueryDto) {
    const startedAt = Date.now();
    const timings: Record<string, number> = {};
    const range = this.resolveRange(query.from, query.to);
    const apartments = await this.listApartments(query.apartmentId);
    if (apartments.length === 0) {
      if (query.apartmentId) throw new NotFoundException('Apartament nie ma mapowania do Hostex');
      throw new ServiceUnavailableException('Brakuje mapowania apartamentów do Hostex');
    }

    const measure = async <T>(name: string, operation: () => Promise<T>) => {
      const sourceStartedAt = Date.now();
      try {
        return await operation();
      } finally {
        timings[name] = Date.now() - sourceStartedAt;
      }
    };
    const [stays, transactions, availability, reviews, tasks] = await Promise.all([
      measure('stays', () => this.loadStays(apartments, range.from, range.to)),
      measure('transactions', () => this.loadTransactions(apartments, range.from, range.to)),
      measure('availability', () => this.loadAvailability(apartments, range.from, range.to)),
      measure('reviews', () => this.loadReviews(apartments, range.from, range.to)),
      measure('tasks', () => this.loadTasks(apartments, range.from, range.to)),
    ]);

    const result = buildStatistics({
      from: range.from,
      to: range.to,
      apartments,
      stays,
      transactions: transactions.items,
      transactionsComplete: transactions.complete,
      unavailableTransactionApartments: transactions.unavailableApartments,
      availabilityByProperty: availability.byProperty,
      availabilityComplete: availability.complete,
      reviews: reviews.items,
      reviewsComplete: reviews.complete,
      unavailableReviewApartments: reviews.unavailableApartments,
      tasks: tasks.items,
      tasksComplete: tasks.complete,
      unavailableTaskApartments: tasks.unavailableApartments,
    });
    this.logger.log(
      `Statystyki ${range.from}–${range.to}: ${Date.now() - startedAt} ms ` +
      `(rezerwacje ${timings.stays} ms, transakcje ${timings.transactions} ms, ` +
      `dostępność ${timings.availability} ms, opinie ${timings.reviews} ms, zadania ${timings.tasks} ms)`,
    );
    return result;
  }

  private async listApartments(apartmentId?: string): Promise<StatisticsApartment[]> {
    const result = await this.pool.query(
      `SELECT apartment.id, apartment.name, mapping.hostex_property_id
       FROM hostex_property_mappings AS mapping
       JOIN apartments AS apartment ON apartment.id = mapping.apartment_id
       WHERE ($1::uuid IS NULL OR apartment.id = $1::uuid)
       ORDER BY apartment.name`,
      [apartmentId ?? null],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      hostexPropertyId: Number(row.hostex_property_id),
    }));
  }

  private async loadStays(apartments: StatisticsApartment[], from: string, to: string): Promise<StatisticsStay[]> {
    const results = await Promise.all(apartments.map(async (apartment) => {
      const endInclusive = previousDate(to);
      const byStayCode = new Map<string, HostexReservationSummary>();

      // Hostex supports independent check-in and check-out date ranges. Fetch
      // both sets, then union them to include every stay overlapping the period
      // without combining cross-date filters in a single provider request.
      const dateFilters = [
        { startCheckInDate: from, endCheckInDate: endInclusive },
        { startCheckOutDate: from, endCheckOutDate: endInclusive },
      ];
      const filteredItems = await Promise.all(dateFilters.map(async (dateFilter) => {
        const items: HostexReservationSummary[] = [];
        const limit = 100;
        for (let offset = 0; offset < 10_000; offset += limit) {
          const raw = await this.hostexClient.getReservations({
            offset,
            limit,
            propertyId: apartment.hostexPropertyId,
            ...dateFilter,
          });
          const page = sanitizeHostexReservations(raw, offset, limit);
          items.push(...page.items);
          if (items.length >= page.total || page.items.length < limit) break;
        }
        return items;
      }));
      for (const items of filteredItems) {
        for (const stay of items) {
          if (stay.checkInDate < to && stay.checkOutDate > from) byStayCode.set(stay.stayCode, stay);
        }
      }

      return [...byStayCode.values()].map((stay) => mapStay(stay, apartment.id));
    }));
    return results.flat();
  }

  private async loadTransactions(apartments: StatisticsApartment[], from: string, to: string) {
    const results = await Promise.all(apartments.map(async (apartment) => {
      const items: StatisticsTransaction[] = [];
      try {
        let propertyCount = 0;
        for (let offset = 0; offset < 10_000; offset += 100) {
          const raw = await this.hostexClient.getTransactions({
            startDate: from,
            endDate: previousDate(to),
            propertyId: apartment.hostexPropertyId,
            offset,
            limit: 100,
          });
          const page = extractList(raw, ['transactions']);
          const mapped = page.items.map(mapTransaction).filter((item): item is StatisticsTransaction => item !== null);
          items.push(...mapped);
          propertyCount += page.items.length;
          if (propertyCount >= page.total || page.items.length < 100) break;
        }
      } catch (error) {
        this.logger.warn(`Nie udało się pobrać transakcji Hostex dla property ${apartment.hostexPropertyId}: ${safeError(error)}`);
        return { items, unavailable: apartment.name };
      }
      return { items, unavailable: null };
    }));
    const unavailableApartments = results.flatMap((result) => result.unavailable ? [result.unavailable] : []);
    return { items: results.flatMap((result) => result.items), complete: unavailableApartments.length === 0, unavailableApartments };
  }

  private async loadAvailability(apartments: StatisticsApartment[], from: string, to: string) {
    const availabilityByProperty: Record<number, StatisticsAvailability> = {};
    if (!this.isAvailabilityRangeSupported(from, previousDate(to))) {
      return { byProperty: availabilityByProperty, complete: false };
    }
    try {
      const raw = await this.hostexClient.getAvailabilities({
        propertyIds: apartments.map((apartment) => apartment.hostexPropertyId),
        startDate: from,
        endDate: previousDate(to),
      });
      const record = asRecord(raw);
      const properties = Array.isArray(raw) ? raw : record?.properties;
      if (!Array.isArray(properties)) throw new BadGatewayException('Hostex zwrócił nieprawidłową dostępność');
      for (const value of properties) {
        const property = asRecord(value);
        const id = positiveInteger(property?.id);
        const rows = property?.availabilities;
        if (id === null || !Array.isArray(rows)) continue;
        const availableByDate: Record<string, boolean> = {};
        for (const dayValue of rows) {
          const day = asRecord(dayValue);
          if (typeof day?.date === 'string' && typeof day.available === 'boolean') {
            availableByDate[day.date] = day.available;
          }
        }
        availabilityByProperty[id] = { availableByDate };
      }
      const expectedDays = dateRange(from, previousDate(to));
      const complete = apartments.every((apartment) => {
        const dates = availabilityByProperty[apartment.hostexPropertyId]?.availableByDate;
        return Boolean(dates) && expectedDays.every((date) => Object.prototype.hasOwnProperty.call(dates, date));
      });
      return { byProperty: availabilityByProperty, complete };
    } catch (error) {
      this.logger.warn(`Nie udało się pobrać kalendarza dostępności Hostex: ${safeError(error)}`);
      return { byProperty: availabilityByProperty, complete: false };
    }
  }

  private async loadReviews(apartments: StatisticsApartment[], from: string, to: string) {
    const chunks = splitRange(from, previousDate(to), 179);
    const results = await Promise.all(apartments.map(async (apartment) => {
      const items: StatisticsReview[] = [];
      try {
        for (const chunk of chunks) {
          for (let offset = 0; offset < 10_000; offset += 100) {
            const raw = await this.hostexClient.getReviews({
              propertyId: apartment.hostexPropertyId,
              startCheckOutDate: chunk.from,
              endCheckOutDate: chunk.to,
              offset,
              limit: 100,
            });
            const page = extractList(raw, ['reviews']);
            const mapped = page.items.map(mapReview).filter((item): item is StatisticsReview => item !== null);
            items.push(...mapped);
            if (page.items.length < 100 || offset + page.items.length >= page.total) break;
          }
        }
      } catch (error) {
        this.logger.warn(`Nie udało się pobrać opinii Hostex dla property ${apartment.hostexPropertyId}: ${safeError(error)}`);
        return { items, unavailable: apartment.name };
      }
      return { items, unavailable: null };
    }));
    const unavailableApartments = results.flatMap((result) => result.unavailable ? [result.unavailable] : []);
    return { items: results.flatMap((result) => result.items), complete: unavailableApartments.length === 0, unavailableApartments };
  }

  private async loadTasks(apartments: StatisticsApartment[], from: string, to: string) {
    const results = await Promise.all(apartments.map(async (apartment) => {
      const items: StatisticsTask[] = [];
      try {
        for (let offset = 0; offset < 10_000; offset += 100) {
          const raw = await this.hostexClient.getTasks({
            startDate: from,
            endDate: previousDate(to),
            propertyId: apartment.hostexPropertyId,
            offset,
            limit: 100,
          });
          const page = extractList(raw, ['tasks']);
          const mapped = page.items.map(mapTask).filter((item): item is StatisticsTask => item !== null);
          items.push(...mapped);
          if (page.items.length < 100 || offset + page.items.length >= page.total) break;
        }
      } catch (error) {
        this.logger.warn(`Nie udało się pobrać zadań Hostex dla property ${apartment.hostexPropertyId}: ${safeError(error)}`);
        return { items, unavailable: apartment.name };
      }
      return { items, unavailable: null };
    }));
    const unavailableApartments = results.flatMap((result) => result.unavailable ? [result.unavailable] : []);
    return { items: results.flatMap((result) => result.items), complete: unavailableApartments.length === 0, unavailableApartments };
  }

  private resolveRange(from?: string, to?: string): { from: string; to: string } {
    const defaults = currentMonthRange();
    const start = from ?? defaults.from;
    const end = to ?? defaults.to;
    if ((from && !to) || (!from && to)) {
      throw new BadRequestException('Podaj jednocześnie daty „from” i „to” albo pomiń obie, aby użyć bieżącego miesiąca.');
    }
    if (!isValidDate(start) || !isValidDate(end) || start >= end) {
      throw new BadRequestException('Zakres statystyk musi mieć poprawne daty, a data „to” musi być późniejsza niż „from”.');
    }
    if (dayDifference(end, start) > 366) {
      throw new BadRequestException('Zakres statystyk nie może przekraczać 366 dni.');
    }
    return { from: start, to: end };
  }

  private isAvailabilityRangeSupported(from: string, endInclusive: string): boolean {
    const today = warsawDate();
    const earliest = addDays(today, -365);
    const latest = addYears(today, 3);
    return from >= earliest && endInclusive <= latest;
  }
}

function mapStay(stay: HostexReservationSummary, apartmentId: string): StatisticsStay {
  return {
    reservationCode: stay.reservationCode,
    apartmentId,
    channelType: stay.channelType,
    status: stay.status,
    checkInDate: stay.checkInDate,
    checkOutDate: stay.checkOutDate,
    bookedAt: stay.bookedAt,
    cancelledAt: stay.cancelledAt,
    guestCount: stay.numberOfGuests ?? 0,
    adults: stay.numberOfAdults ?? 0,
    children: stay.numberOfChildren ?? 0,
    infants: stay.numberOfInfants ?? 0,
    pets: stay.numberOfPets ?? 0,
    amount: stay.totalRateAmount,
    currency: stay.currency,
  };
}

function mapTransaction(value: unknown): StatisticsTransaction | null {
  const row = asRecord(value);
  if (!row) return null;
  const direction = row.direction;
  const amount = finiteNumber(row.amount);
  const id = row.id === undefined || row.id === null ? null : String(row.id);
  const currency = asNonEmptyString(row.currency);
  if (!id || !currency || amount === null || !['income', 'expense'].includes(String(direction))) return null;
  return {
    id,
    direction: direction as 'income' | 'expense',
    amount,
    currency,
    status: asNonEmptyString(row.status) ?? 'unknown',
    actionAt: asNullableString(row.action_at),
    itemName: asNullableString(row.item_name),
    paymentMethodName: asNullableString(row.payment_method_name),
    propertyId: positiveInteger(row.property_id),
  };
}

function mapReview(value: unknown): StatisticsReview | null {
  const row = asRecord(value);
  if (!row) return null;
  const guestReview = asRecord(row.guest_review);
  const score = finiteNumber(
    guestReview?.score ?? guestReview?.rating ?? guestReview?.overall_rating ??
    row.guest_review_score ?? row.rating ?? row.score ?? row.overall_rating,
  );
  return score === null ? null : { score, channelType: asNonEmptyString(row.channel_type ?? row.channelType) ?? undefined };
}

function mapTask(value: unknown): StatisticsTask | null {
  const row = asRecord(value);
  if (!row) return null;
  const type = asNonEmptyString(row.type);
  const status = asNonEmptyString(row.status);
  if (!type || !status) return null;
  return {
    type,
    status,
    fee: finiteNumber(row.fee),
    currency: asNullableString(row.currency),
  };
}

function extractList(data: unknown, keys: string[]): { items: unknown[]; total: number } {
  const record = asRecord(data);
  if (Array.isArray(data)) return { items: data, total: data.length };
  for (const key of keys) {
    const value = record?.[key];
    if (Array.isArray(value)) return { items: value, total: nonNegativeInteger(record?.total) ?? value.length };
  }
  const nested = asRecord(record?.data);
  for (const key of keys) {
    const value = nested?.[key];
    if (Array.isArray(value)) return { items: value, total: nonNegativeInteger(nested?.total ?? record?.total) ?? value.length };
  }
  throw new BadGatewayException(`Hostex zwrócił nieprawidłową listę: ${keys.join(', ')}`);
}

function splitRange(from: string, to: string, maxDays: number): Array<{ from: string; to: string }> {
  const chunks: Array<{ from: string; to: string }> = [];
  for (let start = from; start <= to;) {
    const end = addDays(start, maxDays - 1);
    const boundedEnd = end < to ? end : to;
    chunks.push({ from: start, to: boundedEnd });
    start = addDays(boundedEnd, 1);
  }
  return chunks;
}

function dateRange(from: string, to: string): string[] {
  const days: string[] = [];
  for (let current = from; current <= to; current = addDays(current, 1)) days.push(current);
  return days;
}

function currentMonthRange(): { from: string; to: string } {
  const today = warsawDate();
  const from = `${today.slice(0, 7)}-01`;
  return { from, to: addMonth(from) };
}

function warsawDate(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function previousDate(value: string): string {
  return addDays(value, -1);
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addMonth(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
}

function addYears(value: string, years: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0, 10);
}

function dayDifference(later: string, earlier: string): number {
  return Math.round((Date.parse(`${later}T00:00:00.000Z`) - Date.parse(`${earlier}T00:00:00.000Z`)) / 86_400_000);
}

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as UnknownRecord : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && Number.isInteger(number) && number >= 0 ? number : null;
}

function safeError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message?: unknown }).message || 'błąd');
    return message.replace(/https?:\/\/\S+/gi, '[adres ukryty]').slice(0, 160);
  }
  return 'błąd dostawcy';
}

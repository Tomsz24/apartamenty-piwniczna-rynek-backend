import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { CreateReservationDto, UpdateReservationDto } from '../reservations/reservations.dto';
import { HostexService } from './hostex.service';
import { HostexSyncService } from './hostex-sync.service';

@Injectable()
export class HostexReservationWritesService {
  constructor(
    @Inject('PG_POOL') private readonly pool: Pool,
    private readonly hostexService: HostexService,
    private readonly hostexSyncService: HostexSyncService,
  ) {}

  async create(dto: CreateReservationDto): Promise<{ reservationId: string; clientChannelId: string }> {
    if (dto.status && dto.status !== 'confirmed') {
      throw new BadRequestException('Hostex przyjmuje z aplikacji tylko potwierdzone rezerwacje. Blokady wymagają osobnej obsługi dostępności.');
    }
    const guestName = dto.guestName?.trim();
    if (!guestName) throw new BadRequestException('Hostex wymaga imienia i nazwiska gościa');
    if (dto.totalRateAmount === undefined) {
      throw new BadRequestException('Podaj całkowitą cenę rezerwacji przed zapisaniem jej w Hostex');
    }
    const amountReceived = dto.amountReceived ?? 0;
    if (amountReceived > dto.totalRateAmount) {
      throw new BadRequestException('Otrzymana kwota nie może być wyższa od ceny rezerwacji');
    }

    const mapping = await this.pool.query(
      `SELECT hostex_property_id FROM hostex_property_mappings WHERE apartment_id = $1`,
      [dto.apartmentId],
    );
    const propertyId = Number(mapping.rows[0]?.hostex_property_id);
    if (!Number.isInteger(propertyId) || propertyId < 1) {
      throw new NotFoundException('Wybrany apartament nie ma mapowania do obiektu Hostex');
    }

    const overlaps = await this.pool.query(
      `SELECT id FROM reservations
       WHERE apartment_id = $1 AND origin IN ('manual', 'hostex') AND status <> 'cancelled'
         AND start_date < $3 AND end_date > $2
       LIMIT 1`,
      [dto.apartmentId, dto.startDate, dto.endDate],
    );
    if (overlaps.rows.length > 0) throw new ConflictException('Termin nachodzi na istniejącą rezerwację');

    const [channels, incomeMethods] = await Promise.all([
      this.hostexService.listCustomChannels(),
      this.hostexService.listIncomeMethods(),
    ]);
    const mobileAppChannel = this.findUniqueByName(channels, 'Mobile App', 'kanał');
    const cashMethod = this.findUniqueByName(incomeMethods, 'Cash', 'metoda płatności gotówką');
    const clientChannelId = (dto.clientReservationId ?? randomUUID()).replace(/-/g, '');
    const guestCount = dto.guestCount ?? (dto.adults ?? 0) + (dto.children ?? 0);
    if (!Number.isInteger(guestCount) || guestCount < 1) {
      throw new BadRequestException('Podaj liczbę gości większą od zera');
    }

    await this.hostexService.createDirectReservation({
      property_id: propertyId,
      custom_channel_id: mobileAppChannel.id,
      check_in_date: dto.startDate,
      check_out_date: dto.endDate,
      number_of_guests: guestCount,
      guest_name: guestName,
      ...(dto.guestEmail ? { email: dto.guestEmail } : {}),
      ...(dto.guestPhone ? { mobile: dto.guestPhone } : {}),
      currency: 'PLN',
      rate_amount: dto.totalRateAmount,
      commission_amount: 0,
      received_amount: amountReceived,
      income_method_id: cashMethod.id,
      channel_id: clientChannelId,
    });

    const synced = await this.hostexSyncService.syncReservationByChannelId(clientChannelId);
    return { reservationId: synced.reservationId, clientChannelId };
  }

  async update(reservationId: string, dto: UpdateReservationDto): Promise<void> {
    const link = await this.hostexSyncService.getLinkedReservation(reservationId);
    if (!link.channelId) {
      throw new ConflictException('Hostex nie zwrócił identyfikatora umożliwiającego synchronizację tej zmiany');
    }
    if (dto.status === 'cancelled') {
      await this.cancel(reservationId, link.channelType);
      return;
    }
    if (dto.status !== undefined) {
      throw new ConflictException('Status rezerwacji Hostex zmienia się w Hostex; z aplikacji można ją anulować');
    }

    const payload: Record<string, unknown> = {};
    if (dto.startDate !== undefined) payload.check_in_date = dto.startDate;
    if (dto.endDate !== undefined) payload.check_out_date = dto.endDate;
    if (dto.guestName !== undefined) payload.guest_name = dto.guestName;
    if (dto.guestPhone !== undefined) payload.mobile = dto.guestPhone;
    if (dto.guestEmail !== undefined) payload.email = dto.guestEmail;
    if (dto.guestCount !== undefined) payload.number_of_guests = dto.guestCount;
    if (Object.keys(payload).length > 0) {
      await this.hostexService.updateDirectReservation(link.stayCode, payload);
    }
  }

  async cancel(reservationId: string, channelType?: string | null): Promise<void> {
    const link = await this.hostexSyncService.getLinkedReservation(reservationId);
    const resolvedChannelType = channelType ?? link.channelType;
    if (resolvedChannelType !== 'hostex_direct') {
      throw new ConflictException(
        'Hostex API pozwala anulować tylko rezerwacje bezpośrednie. Rezerwację z Booking.com anuluj w Hostex lub Booking.com.',
      );
    }
    if (!link.reservationCode) throw new ConflictException('Brak kodu rezerwacji Hostex potrzebnego do anulowania');
    if (!link.channelId) throw new ConflictException('Brak identyfikatora rezerwacji Hostex do odświeżenia po anulowaniu');
    await this.hostexService.cancelDirectReservation(link.reservationCode);
  }

  private findUniqueByName(
    items: Array<{ id: number; name: string }>,
    targetName: string,
    label: string,
  ): { id: number; name: string } {
    const matches = items.filter((item) => item.name.trim().toLowerCase() === targetName.toLowerCase());
    if (matches.length !== 1) {
      throw new NotFoundException(
        `Hostex musi zwrócić dokładnie jedną pozycję „${targetName}” (${label}); znaleziono: ${matches.length}`,
      );
    }
    return matches[0];
  }
}

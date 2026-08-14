import {
  BadRequestException,
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { ConfigService } from '@nestjs/config';
import { ReservationActor } from '../reservations/reservations.types';
import { TtlockService } from '../ttlock/ttlock.service';
import { AccessCodeCryptoService } from './access-code-crypto.service';
import {
  buildAccessCodeValidity,
  decodeAccessCodeCursor,
  encodeAccessCodeCursor,
  formatDateInTimeZone,
  generateFourDigitCode,
} from './access-codes.domain';
import {
  CreateAccessCodeDto,
  CreateReplacementDraftDto,
  ApplyAccessCodeDraftDto,
  AccessCodesOverviewQueryDto,
  ListAccessCodesQueryDto,
  UpdateAccessCodeDto,
} from './access-codes.dto';
import {
  AccessCodeDto,
  AccessCodeDraftDto,
  AccessCodePageDto,
  ApplyAccessCodeDraftResultDto,
  AccessCodesStatusDto,
  AccessCodeUsageDto,
  AccessCodesOverviewDto,
} from './access-codes.types';

type AccessCodeContext = {
  reservationId: string;
  apartmentId: string;
  apartmentName: string;
  guestName: string | null;
  stayStartDate: string;
  stayEndDate: string;
  defaultCheckInTime: string;
  defaultCheckOutTime: string;
  timeZone: string;
  accessDeviceId: string;
  providerLockId: number;
};

type Candidate = {
  code: string;
  encrypted: string;
  fingerprint: string;
};

@Injectable()
export class AccessCodesService {
  private readonly draftTtlMinutes: number;

  constructor(
    @Inject('PG_POOL') private readonly pool: Pool,
    private readonly ttlockService: TtlockService,
    private readonly cryptoService: AccessCodeCryptoService,
    configService: ConfigService,
  ) {
    const configured = Number(configService.get<string>('ACCESS_CODE_DRAFT_TTL_MINUTES'));
    this.draftTtlMinutes =
      Number.isInteger(configured) && configured >= 5 && configured <= 1440 ? configured : 30;
  }

  getStatus(): AccessCodesStatusDto {
    const ttlock = this.ttlockService.getStatus();
    return {
      encryptionConfigured: this.cryptoService.isConfigured(),
      ttlockWritesEnabled: ttlock.writesEnabled,
      writeMode: ttlock.writesEnabled ? 'controlled_test' : 'blocked',
    };
  }

  async list(query: ListAccessCodesQueryDto): Promise<AccessCodePageDto> {
    if (query.from && query.to) {
      this.assertDateRange(new Date(query.from), new Date(query.to));
    }
    const cursor = decodeAccessCodeCursor(query.cursor);
    const limit = query.limit ?? 50;
    const result = await this.pool.query(
      `
        SELECT
          code.*,
          apartment.name AS apartment_name,
          reservation.guest_name,
          reservation.start_date AS stay_start_date,
          reservation.end_date AS stay_end_date,
          device.provider_device_id,
          device.display_name AS access_device_display_name,
          CASE
            WHEN code.status = 'active' AND code.valid_until <= NOW() THEN 'expired'
            ELSE code.status
          END AS display_status
        FROM reservation_access_codes AS code
        JOIN reservations AS reservation ON reservation.id = code.reservation_id
        JOIN apartments AS apartment ON apartment.id = code.apartment_id
        JOIN apartment_access_devices AS device ON device.id = code.access_device_id
        WHERE ($1::uuid IS NULL OR code.apartment_id = $1::uuid)
          AND ($2::uuid IS NULL OR code.reservation_id = $2::uuid)
          AND (
            $3::text IS NULL OR
            CASE
              WHEN code.status = 'active' AND code.valid_until <= NOW() THEN 'expired'
              ELSE code.status
            END = $3::text
          )
          AND ($4::timestamptz IS NULL OR code.valid_until > $4::timestamptz)
          AND ($5::timestamptz IS NULL OR code.valid_from < $5::timestamptz)
          AND (
            $6::timestamptz IS NULL OR
            (code.valid_from, code.id) < ($6::timestamptz, $7::uuid)
          )
        ORDER BY code.valid_from DESC, code.id DESC
        LIMIT $8
      `,
      [
        query.apartmentId ?? null,
        query.reservationId ?? null,
        query.status ?? null,
        query.from ?? null,
        query.to ?? null,
        cursor?.validFrom ?? null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );

    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
    const last = rows.at(-1);
    return {
      items: rows.map((row) => this.mapAccessCode(row)),
      nextCursor:
        hasMore && last
          ? encodeAccessCodeCursor({
              validFrom: this.formatTimestamp(last.valid_from),
              id: last.id,
            })
          : null,
    };
  }

  async getById(id: string): Promise<AccessCodeDto> {
    const result = await this.pool.query(
      `
        SELECT
          code.*,
          apartment.name AS apartment_name,
          reservation.guest_name,
          reservation.start_date AS stay_start_date,
          reservation.end_date AS stay_end_date,
          device.provider_device_id,
          device.display_name AS access_device_display_name,
          CASE
            WHEN code.status = 'active' AND code.valid_until <= NOW() THEN 'expired'
            ELSE code.status
          END AS display_status
        FROM reservation_access_codes AS code
        JOIN reservations AS reservation ON reservation.id = code.reservation_id
        JOIN apartments AS apartment ON apartment.id = code.apartment_id
        JOIN apartment_access_devices AS device ON device.id = code.access_device_id
        WHERE code.id = $1
      `,
      [id],
    );
    if (result.rows.length === 0) {
      throw new NotFoundException('Kod dostępu nie został znaleziony');
    }
    return this.mapAccessCode(result.rows[0]);
  }

  async getOverview(query: AccessCodesOverviewQueryDto): Promise<AccessCodesOverviewDto> {
    const includeStatistics = query.includeStatistics ?? false;
    const statisticsDays = query.statisticsDays ?? 30;
    const generatedAt = new Date();
    const statisticsFrom = new Date(
      generatedAt.getTime() - statisticsDays * 24 * 60 * 60 * 1_000,
    );

    const [locks, gateways, mappingsResult] = await Promise.all([
      this.ttlockService.listLocks(),
      this.ttlockService.listGateways(),
      this.pool.query(
        `
          SELECT
            device.id AS access_device_id,
            device.provider_device_id,
            device.display_name,
            device.scope,
            device.apartment_id,
            apartment.name AS apartment_name,
            COUNT(code.id) FILTER (
              WHERE code.status = 'active'
                AND code.valid_from <= NOW()
                AND code.valid_until > NOW()
            ) AS current_code_count,
            COUNT(code.id) FILTER (
              WHERE code.status = 'active'
                AND code.valid_from > NOW()
            ) AS upcoming_code_count,
            COUNT(code.id) FILTER (WHERE code.status = 'sync_error') AS sync_error_count
          FROM apartment_access_devices AS device
          LEFT JOIN apartments AS apartment ON apartment.id = device.apartment_id
          LEFT JOIN reservation_access_codes AS code ON code.access_device_id = device.id
          WHERE device.provider = 'ttlock' AND device.active = true
          GROUP BY device.id, apartment.name
        `,
      ),
    ]);
    const mappings = new Map(
      mappingsResult.rows.map((row) => [Number(row.provider_device_id), row]),
    );
    const statistics = includeStatistics
      ? await Promise.all(
          locks.map((lock) =>
            this.ttlockService.getLockStatistics({
              lockId: lock.lockId,
              startAt: statisticsFrom,
              endAt: generatedAt,
            }),
          ),
        )
      : locks.map(() => null);

    return {
      generatedAt: generatedAt.toISOString(),
      batterySource: 'ttlock_cloud',
      gateways: {
        total: gateways.length,
        online: gateways.filter((gateway) => gateway.online).length,
        offline: gateways.filter((gateway) => !gateway.online).length,
      },
      statisticsRange: includeStatistics
        ? {
            from: statisticsFrom.toISOString(),
            to: generatedAt.toISOString(),
            requestedDays: statisticsDays,
            providerRetentionGuaranteed: false,
          }
        : null,
      locks: locks.map((lock, index) => {
        const mapping = mappings.get(lock.lockId);
        return {
          lockId: lock.lockId,
          name: lock.name,
          alias: lock.alias,
          batteryPercentage: lock.batteryPercentage,
          batteryLevel: this.batteryLevel(lock.batteryPercentage),
          hasGateway: lock.hasGateway,
          keyboardPwdVersion: lock.keyboardPwdVersion,
          mapping: mapping
            ? {
                accessDeviceId: mapping.access_device_id,
                displayName: mapping.display_name ?? null,
                scope: mapping.scope,
                apartmentId: mapping.apartment_id ?? null,
                apartmentName: mapping.apartment_name ?? null,
              }
            : null,
          codeCounts: {
            current: mapping ? Number(mapping.current_code_count) : 0,
            upcoming: mapping ? Number(mapping.upcoming_code_count) : 0,
            syncErrors: mapping ? Number(mapping.sync_error_count) : 0,
          },
          statistics: statistics[index],
        };
      }),
    };
  }

  async ensureForReservation(
    reservationId: string,
    actor: ReservationActor,
  ): Promise<AccessCodeDto> {
    const current = await this.pool.query(
      `
        SELECT id, status
        FROM reservation_access_codes
        WHERE reservation_id = $1 AND status <> 'revoked'
        LIMIT 1
      `,
      [reservationId],
    );
    if (current.rows.length > 0) {
      if (current.rows[0].status === 'active') return this.getById(current.rows[0].id);
      throw new ConflictException(
        'Rezerwacja ma kod w trakcie synchronizacji albo wymagający sprawdzenia',
      );
    }

    const context = await this.loadContext(reservationId);
    this.ttlockService.assertWritesAllowed();
    const { validFrom, validUntil } = buildAccessCodeValidity({
      startDate: context.stayStartDate,
      endDate: context.stayEndDate,
      checkInTime: context.defaultCheckInTime,
      checkOutTime: context.defaultCheckOutTime,
      timeZone: context.timeZone,
    });
    const name = this.normalizeName(
      [context.guestName, context.stayStartDate].filter(Boolean).join(' / '),
    );
    const candidate = await this.generateAvailableCandidate(
      context.accessDeviceId,
      context.providerLockId,
      validFrom,
      validUntil,
    );
    const accessCodeId = await this.reserveCandidate(
      context,
      candidate,
      name,
      validFrom,
      validUntil,
      actor,
      {
        validitySource: 'apartment_default',
        timeZone: context.timeZone,
        defaultCheckInTime: context.defaultCheckInTime,
        defaultCheckOutTime: context.defaultCheckOutTime,
      },
    );
    if (!accessCodeId) {
      throw new ConflictException('Wylosowany kod przestał być dostępny. Ponów operację.');
    }
    return this.provisionCreatedAccessCode({
      accessCodeId,
      context,
      candidate,
      name,
      startAt: validFrom,
      endAt: validUntil,
      actor,
      auditDetails: { trigger: 'reservation_automation' },
    });
  }

  async createDraft(
    dto: CreateAccessCodeDto,
    actor: ReservationActor,
  ): Promise<AccessCodeDraftDto> {
    const startAt = new Date(dto.validFrom);
    const endAt = new Date(dto.validUntil);
    this.assertDateRange(startAt, endAt);
    const context = await this.loadContext(dto.reservationId);
    await this.expireDrafts(context.reservationId);

    const currentCode = await this.pool.query(
      `SELECT id FROM reservation_access_codes WHERE reservation_id = $1 AND status <> 'revoked' LIMIT 1`,
      [context.reservationId],
    );
    if (currentCode.rows.length > 0) {
      throw new ConflictException(
        'Rezerwacja ma już kod. Aby go zmienić, przygotuj szkic zastąpienia.',
      );
    }
    const existing = await this.findOpenDraft(context.reservationId);
    if (existing) return this.getDraft(existing);

    const name = this.normalizeName(
      dto.name || [context.guestName, context.stayStartDate].filter(Boolean).join(' / '),
    );
    const candidate = await this.generateAvailableCandidate(
      context.accessDeviceId,
      context.providerLockId,
      startAt,
      endAt,
    );
    const expiresAt = new Date(Date.now() + this.draftTtlMinutes * 60_000);
    const result = await this.pool.query(
      `
        INSERT INTO access_code_drafts (
          reservation_id,
          apartment_id,
          access_device_id,
          action,
          code_ciphertext,
          code_fingerprint,
          code_name,
          valid_from,
          valid_until,
          expires_at,
          created_by
        )
        VALUES ($1, $2, $3, 'create', $4, $5, $6, $7, $8, $9, $10)
        RETURNING id
      `,
      [
        context.reservationId,
        context.apartmentId,
        context.accessDeviceId,
        candidate.encrypted,
        candidate.fingerprint,
        name,
        startAt.toISOString(),
        endAt.toISOString(),
        expiresAt.toISOString(),
        this.actorName(actor),
      ],
    );
    return this.getDraft(result.rows[0].id);
  }

  async createReplacementDraft(
    accessCodeId: string,
    dto: CreateReplacementDraftDto,
    actor: ReservationActor,
  ): Promise<AccessCodeDraftDto> {
    const row = await this.loadMutableRow(accessCodeId);
    if (row.version !== dto.expectedVersion) {
      throw new ConflictException('Kod został w międzyczasie zmieniony. Odśwież dane.');
    }
    if (row.status !== 'active' || !row.provider_passcode_id) {
      throw new ConflictException('Tylko aktywny i zsynchronizowany kod można zastąpić');
    }
    await this.expireDrafts(row.reservation_id);
    const existing = await this.findOpenDraft(row.reservation_id);
    if (existing) return this.getDraft(existing);

    const startAt = new Date(dto.validFrom ?? row.valid_from);
    const endAt = new Date(dto.validUntil ?? row.valid_until);
    this.assertDateRange(startAt, endAt);
    const validityChanged = dto.validFrom !== undefined || dto.validUntil !== undefined;
    if (validityChanged) this.assertManualWindowMatchesStay(row, startAt, endAt);
    const name = dto.name === undefined ? row.code_name : this.normalizeName(dto.name);
    const candidate = await this.generateAvailableCandidate(
      row.access_device_id,
      Number(row.provider_device_id),
      startAt,
      endAt,
      accessCodeId,
    );
    const expiresAt = new Date(Date.now() + this.draftTtlMinutes * 60_000);
    const result = await this.pool.query(
      `
        INSERT INTO access_code_drafts (
          reservation_id,
          access_code_id,
          apartment_id,
          access_device_id,
          action,
          code_ciphertext,
          code_fingerprint,
          code_name,
          valid_from,
          valid_until,
          source_version,
          expires_at,
          created_by
        )
        VALUES ($1, $2, $3, $4, 'replace', $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id
      `,
      [
        row.reservation_id,
        accessCodeId,
        row.apartment_id,
        row.access_device_id,
        candidate.encrypted,
        candidate.fingerprint,
        name,
        startAt.toISOString(),
        endAt.toISOString(),
        dto.expectedVersion,
        expiresAt.toISOString(),
        this.actorName(actor),
      ],
    );
    return this.getDraft(result.rows[0].id);
  }

  async getDraft(id: string): Promise<AccessCodeDraftDto> {
    const result = await this.pool.query(
      `
        SELECT
          draft.*,
          apartment.name AS apartment_name,
          reservation.guest_name,
          device.provider_device_id,
          device.display_name AS access_device_display_name,
          CASE
            WHEN draft.status = 'draft' AND draft.expires_at <= NOW() THEN 'expired'
            WHEN draft.status = 'applying' AND draft.updated_at <= NOW() - INTERVAL '2 minutes'
              THEN 'sync_error'
            ELSE draft.status
          END AS display_status,
          CASE
            WHEN draft.status = 'applying' AND draft.updated_at <= NOW() - INTERVAL '2 minutes'
              THEN 'Operacja nie zakończyła się w oczekiwanym czasie. Sprawdź stan kodu w TTLock.'
            ELSE draft.last_error
          END AS display_error
        FROM access_code_drafts AS draft
        JOIN reservations AS reservation ON reservation.id = draft.reservation_id
        JOIN apartments AS apartment ON apartment.id = draft.apartment_id
        JOIN apartment_access_devices AS device ON device.id = draft.access_device_id
        WHERE draft.id = $1
      `,
      [id],
    );
    if (result.rows.length === 0) throw new NotFoundException('Szkic kodu nie istnieje');
    return this.mapDraft(result.rows[0]);
  }

  async getOpenDraftForReservation(reservationId: string): Promise<AccessCodeDraftDto> {
    await this.expireDrafts(reservationId);
    const result = await this.pool.query(
      `
        SELECT id
        FROM access_code_drafts
        WHERE reservation_id = $1 AND status <> 'cancelled'
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [reservationId],
    );
    if (result.rows.length === 0) {
      throw new NotFoundException('Rezerwacja nie ma szkicu kodu');
    }
    return this.getDraft(result.rows[0].id);
  }

  async cancelDraft(
    id: string,
    expectedDraftVersion: number,
  ): Promise<AccessCodeDraftDto> {
    const result = await this.pool.query(
      `
        UPDATE access_code_drafts
        SET status = 'cancelled',
            cancelled_at = NOW(),
            updated_at = NOW(),
            version = version + 1
        WHERE id = $1 AND status = 'draft' AND version = $2
        RETURNING id
      `,
      [id, expectedDraftVersion],
    );
    if (result.rows.length === 0) {
      throw new ConflictException('Szkic wygasł albo został już wykorzystany');
    }
    return this.getDraft(id);
  }

  async applyDraft(
    id: string,
    dto: ApplyAccessCodeDraftDto,
    actor: ReservationActor,
  ): Promise<ApplyAccessCodeDraftResultDto> {
    this.ttlockService.assertWritesAllowed();
    let row = await this.loadDraftRow(id);
    if (row.status === 'applied') {
      return {
        draft: await this.getDraft(id),
        accessCode: row.applied_access_code_id
          ? await this.getById(row.applied_access_code_id)
          : null,
      };
    }
    if (row.status !== 'draft' || new Date(row.expires_at).getTime() <= Date.now()) {
      throw new ConflictException('Szkic wygasł, został anulowany albo wymaga sprawdzenia');
    }
    const claimed = await this.pool.query(
      `
        UPDATE access_code_drafts
        SET status = 'applying', updated_at = NOW(), version = version + 1
        WHERE id = $1
          AND status = 'draft'
          AND version = $2
          AND expires_at > NOW()
        RETURNING *
      `,
      [id, dto.expectedDraftVersion],
    );
    if (claimed.rows.length === 0) {
      row = await this.loadDraftRow(id);
      if (row.status === 'applied') {
        return {
          draft: await this.getDraft(id),
          accessCode: row.applied_access_code_id
            ? await this.getById(row.applied_access_code_id)
            : null,
        };
      }
      throw new ConflictException(
        'Szkic jest już przetwarzany albo został zmieniony. Odczytaj jego aktualny stan.',
      );
    }
    row = { ...row, ...claimed.rows[0] };

    try {
      const accessCode =
        row.action === 'create'
          ? await this.applyCreateDraft(row, actor)
          : await this.applyReplacementDraft(row, actor);
      await this.pool.query(
        `
          UPDATE access_code_drafts
          SET status = 'applied',
              applied_access_code_id = $2,
              applied_at = NOW(),
              last_error = NULL,
              updated_at = NOW()
          WHERE id = $1
        `,
        [id, accessCode.id],
      );
      return { draft: await this.getDraft(id), accessCode };
    } catch (error) {
      await this.pool.query(
        `
          UPDATE access_code_drafts
          SET status = 'sync_error', last_error = $2, updated_at = NOW()
          WHERE id = $1
        `,
        [id, this.errorMessage(error)],
      );
      throw error;
    }
  }

  async update(
    id: string,
    dto: UpdateAccessCodeDto,
    actor: ReservationActor,
  ): Promise<AccessCodeDto> {
    this.ttlockService.assertWritesAllowed();
    if (
      dto.validFrom === undefined &&
      dto.validUntil === undefined
    ) {
      throw new BadRequestException('Nie przekazano nowych godzin ważności kodu');
    }
    const row = await this.loadMutableRow(id);
    if (row.version !== dto.expectedVersion) {
      throw new ConflictException('Kod został w międzyczasie zmieniony. Odśwież dane.');
    }
    if (row.status !== 'active') {
      throw new ConflictException(
        'Można modyfikować tylko zsynchronizowany kod aktywny. Ten rekord wymaga sprawdzenia.',
      );
    }
    if (!row.provider_passcode_id) {
      throw new ConflictException('Kod nie ma identyfikatora TTLock i wymaga sprawdzenia');
    }

    const startAt = new Date(dto.validFrom ?? row.valid_from);
    const endAt = new Date(dto.validUntil ?? row.valid_until);
    this.assertDateRange(startAt, endAt);
    const validityChanged = dto.validFrom !== undefined || dto.validUntil !== undefined;
    if (validityChanged) this.assertManualWindowMatchesStay(row, startAt, endAt);
    const name = row.code_name;
    const encrypted = row.code_ciphertext;
    const fingerprint = row.code_fingerprint;

    const pendingVersion = await this.prepareUpdate({
      id,
      accessDeviceId: row.access_device_id,
      expectedVersion: dto.expectedVersion,
      encrypted,
      fingerprint,
      name,
      startAt,
      endAt,
      actor,
      validitySource: validityChanged ? 'manual_override' : undefined,
    });
    await this.recordEvent(id, 'update_requested', actor, {
      regenerateCode: false,
      version: pendingVersion,
    });

    try {
      await this.ttlockService.changePasscode({
        lockId: Number(row.provider_device_id),
        keyboardPwdId: Number(row.provider_passcode_id),
        name,
        startAt,
        endAt,
      });
      await this.confirmProviderPasscode({
        lockId: Number(row.provider_device_id),
        keyboardPwdId: Number(row.provider_passcode_id),
        passcode: this.cryptoService.decrypt(row.code_ciphertext),
        startAt,
        endAt,
      });
      await this.pool.query(
        `
          UPDATE reservation_access_codes
          SET status = 'active', provider_synced_at = NOW(), last_error = NULL, updated_at = NOW()
          WHERE id = $1
        `,
        [id],
      );
      await this.recordEvent(id, 'updated', actor, {
        regenerateCode: false,
        validitySource: validityChanged ? 'manual_override' : undefined,
      });
      return this.getById(id);
    } catch (error) {
      await this.markSyncError(id, error, actor, 'update_failed');
      throw error;
    }
  }

  async revoke(
    id: string,
    expectedVersion: number,
    actor: ReservationActor,
  ): Promise<AccessCodeDto> {
    this.ttlockService.assertWritesAllowed();
    const row = await this.loadMutableRow(id);
    if (row.version !== expectedVersion) {
      throw new ConflictException('Kod został w międzyczasie zmieniony. Odśwież dane.');
    }
    if (row.status === 'revoked') return this.getById(id);
    if (row.status !== 'active') {
      throw new ConflictException(
        'Można usunąć tylko zsynchronizowany kod aktywny. Ten rekord wymaga sprawdzenia.',
      );
    }
    if (!row.provider_passcode_id) {
      throw new ConflictException('Kod nie ma identyfikatora TTLock i wymaga sprawdzenia');
    }

    const pending = await this.pool.query(
      `
        UPDATE reservation_access_codes
        SET status = 'pending_delete',
            updated_by = $3,
            updated_at = NOW(),
            version = version + 1,
            last_error = NULL
        WHERE id = $1 AND version = $2
        RETURNING version
      `,
      [id, expectedVersion, this.actorName(actor)],
    );
    if (pending.rows.length === 0) {
      throw new ConflictException('Kod został w międzyczasie zmieniony. Odśwież dane.');
    }
    await this.recordEvent(id, 'delete_requested', actor, {
      version: pending.rows[0].version,
    });

    try {
      await this.ttlockService.deletePasscode(
        Number(row.provider_device_id),
        Number(row.provider_passcode_id),
      );
      await this.pool.query(
        `
          UPDATE reservation_access_codes
          SET status = 'revoked',
              revoked_at = NOW(),
              revoked_by = $2,
              provider_synced_at = NOW(),
              last_error = NULL,
              updated_at = NOW()
          WHERE id = $1
        `,
        [id, this.actorName(actor)],
      );
      await this.recordEvent(id, 'revoked', actor, {});
      return this.getById(id);
    } catch (error) {
      await this.markSyncError(id, error, actor, 'delete_failed');
      throw error;
    }
  }

  async getUsage(id: string): Promise<AccessCodeUsageDto> {
    const row = await this.loadMutableRow(id);
    const usage = await this.ttlockService.getPasscodeUsage({
      lockId: Number(row.provider_device_id),
      passcode: this.cryptoService.decrypt(row.code_ciphertext),
      startAt: new Date(row.valid_from),
      endAt: new Date(row.valid_until),
    });
    return { accessCodeId: id, ...usage };
  }

  async refreshUsage(id: string): Promise<AccessCodeUsageDto> {
    const usage = await this.getUsage(id);
    await this.pool.query(
      `
        UPDATE reservation_access_codes
        SET usage_count = $2,
            first_used_at = $3,
            last_used_at = $4,
            usage_synced_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `,
      [id, usage.usageCount, usage.firstUsedAt, usage.lastUsedAt],
    );
    return usage;
  }

  private async applyCreateDraft(row: any, actor: ReservationActor): Promise<AccessCodeDto> {
    const startAt = new Date(row.valid_from);
    const endAt = new Date(row.valid_until);
    const candidate: Candidate = {
      code: this.cryptoService.decrypt(row.code_ciphertext),
      encrypted: row.code_ciphertext,
      fingerprint: row.code_fingerprint,
    };
    const context: AccessCodeContext = {
      reservationId: row.reservation_id,
      apartmentId: row.apartment_id,
      apartmentName: '',
      guestName: null,
      stayStartDate: '',
      stayEndDate: '',
      defaultCheckInTime: '',
      defaultCheckOutTime: '',
      timeZone: 'Europe/Warsaw',
      accessDeviceId: row.access_device_id,
      providerLockId: Number(row.provider_device_id),
    };
    const accessCodeId = await this.reserveCandidate(
      context,
      candidate,
      row.code_name,
      startAt,
      endAt,
      actor,
      { validitySource: 'manual_draft', timeZone: 'Europe/Warsaw' },
    );
    if (!accessCodeId) {
      throw new ConflictException('Wybrany kod przestał być dostępny. Wylosuj nowy szkic.');
    }
    await this.pool.query(
      `UPDATE access_code_drafts SET applied_access_code_id = $2, updated_at = NOW() WHERE id = $1`,
      [row.id, accessCodeId],
    );

    return this.provisionCreatedAccessCode({
      accessCodeId,
      context,
      candidate,
      name: row.code_name,
      startAt,
      endAt,
      actor,
      auditDetails: { draftId: row.id },
    });
  }

  private async provisionCreatedAccessCode(params: {
    accessCodeId: string;
    context: AccessCodeContext;
    candidate: Candidate;
    name: string | null;
    startAt: Date;
    endAt: Date;
    actor: ReservationActor;
    auditDetails: Record<string, unknown>;
  }): Promise<AccessCodeDto> {
    try {
      const providerResult = await this.ttlockService.createPasscode({
        lockId: params.context.providerLockId,
        passcode: params.candidate.code,
        name: params.name,
        startAt: params.startAt,
        endAt: params.endAt,
      });
      await this.pool.query(
        `
          UPDATE reservation_access_codes
          SET provider_passcode_id = $2, updated_at = NOW()
          WHERE id = $1
        `,
        [params.accessCodeId, providerResult.keyboardPwdId],
      );
      await this.confirmProviderPasscode({
        lockId: params.context.providerLockId,
        keyboardPwdId: providerResult.keyboardPwdId,
        passcode: params.candidate.code,
        startAt: params.startAt,
        endAt: params.endAt,
      });
      await this.pool.query(
        `
          UPDATE reservation_access_codes
          SET status = 'active',
              provider_synced_at = NOW(),
              last_error = NULL,
              updated_at = NOW()
          WHERE id = $1
        `,
        [params.accessCodeId],
      );
      await this.recordEvent(params.accessCodeId, 'created', params.actor, {
        providerPasscodeId: providerResult.keyboardPwdId,
        providerConfirmed: true,
        ...params.auditDetails,
      });
      return this.getById(params.accessCodeId);
    } catch (error) {
      await this.markSyncError(
        params.accessCodeId,
        error,
        params.actor,
        'create_failed',
      );
      throw error;
    }
  }

  private async applyReplacementDraft(
    row: any,
    actor: ReservationActor,
  ): Promise<AccessCodeDto> {
    const current = await this.loadMutableRow(row.access_code_id);
    if (current.version !== row.source_version || current.status !== 'active') {
      throw new ConflictException(
        'Kod źródłowy zmienił się po przygotowaniu szkicu. Wylosuj nowy szkic.',
      );
    }
    if (!current.provider_passcode_id) {
      throw new ConflictException('Kod źródłowy nie ma identyfikatora TTLock');
    }
    const startAt = new Date(row.valid_from);
    const endAt = new Date(row.valid_until);
    const code = this.cryptoService.decrypt(row.code_ciphertext);
    const pendingVersion = await this.prepareUpdate({
      id: current.id,
      accessDeviceId: current.access_device_id,
      expectedVersion: row.source_version,
      encrypted: row.code_ciphertext,
      fingerprint: row.code_fingerprint,
      name: row.code_name,
      startAt,
      endAt,
      actor,
      validitySource: 'manual_override',
    });
    await this.pool.query(
      `UPDATE access_code_drafts SET applied_access_code_id = $2, updated_at = NOW() WHERE id = $1`,
      [row.id, current.id],
    );
    await this.recordEvent(current.id, 'update_requested', actor, {
      regenerateCode: true,
      version: pendingVersion,
      draftId: row.id,
    });

    try {
      await this.ttlockService.changePasscode({
        lockId: Number(current.provider_device_id),
        keyboardPwdId: Number(current.provider_passcode_id),
        newPasscode: code,
        name: row.code_name,
        startAt,
        endAt,
      });
      await this.confirmProviderPasscode({
        lockId: Number(current.provider_device_id),
        keyboardPwdId: Number(current.provider_passcode_id),
        passcode: code,
        startAt,
        endAt,
      });
      await this.pool.query(
        `
          UPDATE reservation_access_codes
          SET status = 'active', provider_synced_at = NOW(), last_error = NULL, updated_at = NOW()
          WHERE id = $1
        `,
        [current.id],
      );
      await this.recordEvent(current.id, 'updated', actor, {
        regenerateCode: true,
        draftId: row.id,
      });
      return this.getById(current.id);
    } catch (error) {
      await this.markSyncError(current.id, error, actor, 'update_failed');
      throw error;
    }
  }

  private async loadDraftRow(id: string): Promise<any> {
    const result = await this.pool.query(
      `
        SELECT draft.*, device.provider_device_id
        FROM access_code_drafts AS draft
        JOIN apartment_access_devices AS device ON device.id = draft.access_device_id
        WHERE draft.id = $1
      `,
      [id],
    );
    if (result.rows.length === 0) throw new NotFoundException('Szkic kodu nie istnieje');
    return result.rows[0];
  }

  private async expireDrafts(reservationId: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE access_code_drafts
        SET status = 'cancelled',
            cancelled_at = NOW(),
            last_error = 'Szkic wygasł przed zatwierdzeniem',
            updated_at = NOW(),
            version = version + 1
        WHERE reservation_id = $1 AND status = 'draft' AND expires_at <= NOW()
      `,
      [reservationId],
    );
  }

  private async findOpenDraft(reservationId: string): Promise<string | null> {
    const result = await this.pool.query(
      `
        SELECT id
        FROM access_code_drafts
        WHERE reservation_id = $1
          AND (
            status = 'applying'
            OR (status = 'draft' AND expires_at > NOW())
          )
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [reservationId],
    );
    return result.rows[0]?.id ?? null;
  }

  private async loadContext(reservationId: string): Promise<AccessCodeContext> {
    const result = await this.pool.query(
      `
        SELECT
          reservation.id AS reservation_id,
          reservation.apartment_id,
          reservation.guest_name,
          reservation.start_date,
          reservation.end_date,
          reservation.status,
          apartment.name AS apartment_name,
          apartment.access_code_check_in_time,
          apartment.access_code_check_out_time,
          apartment.access_code_time_zone,
          device.id AS access_device_id,
          device.provider_device_id
        FROM reservations AS reservation
        JOIN apartments AS apartment ON apartment.id = reservation.apartment_id
        LEFT JOIN apartment_access_devices AS device
          ON device.apartment_id = reservation.apartment_id
         AND device.provider = 'ttlock'
         AND device.scope = 'apartment'
         AND device.active = true
        WHERE reservation.id = $1
      `,
      [reservationId],
    );
    if (result.rows.length === 0) throw new NotFoundException('Rezerwacja nie istnieje');
    const row = result.rows[0];
    if (row.status !== 'confirmed') {
      throw new ConflictException('Kod można utworzyć tylko dla potwierdzonej rezerwacji');
    }
    if (!row.access_device_id || !row.provider_device_id) {
      throw new ConflictException('Apartament nie ma przypisanego zamka TTLock');
    }
    return {
      reservationId: row.reservation_id,
      apartmentId: row.apartment_id,
      apartmentName: row.apartment_name,
      guestName: row.guest_name ?? null,
      stayStartDate: this.formatDate(row.start_date),
      stayEndDate: this.formatDate(row.end_date),
      defaultCheckInTime: this.formatTime(row.access_code_check_in_time),
      defaultCheckOutTime: this.formatTime(row.access_code_check_out_time),
      timeZone: row.access_code_time_zone,
      accessDeviceId: row.access_device_id,
      providerLockId: Number(row.provider_device_id),
    };
  }

  private async generateAvailableCandidate(
    accessDeviceId: string,
    providerLockId: number,
    startAt: Date,
    endAt: Date,
    excludeId?: string,
  ): Promise<Candidate> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = generateFourDigitCode();
      const fingerprint = this.cryptoService.fingerprint(code);
      const local = await this.pool.query(
        `
          SELECT 1
          FROM reservation_access_codes
          WHERE access_device_id = $1
            AND code_fingerprint = $2
            AND status <> 'revoked'
            AND valid_from < $4
            AND valid_until > $3
            AND ($5::uuid IS NULL OR id <> $5::uuid)
          LIMIT 1
        `,
        [accessDeviceId, fingerprint, startAt.toISOString(), endAt.toISOString(), excludeId ?? null],
      );
      if (local.rows.length > 0) continue;
      const draft = await this.pool.query(
        `
          SELECT 1
          FROM access_code_drafts
          WHERE access_device_id = $1
            AND code_fingerprint = $2
            AND status IN ('draft', 'applying')
            AND expires_at > NOW()
            AND valid_from < $4
            AND valid_until > $3
          LIMIT 1
        `,
        [accessDeviceId, fingerprint, startAt.toISOString(), endAt.toISOString()],
      );
      if (draft.rows.length > 0) continue;
      if (
        !(await this.ttlockService.isPasscodeAvailable({
          lockId: providerLockId,
          passcode: code,
          startAt,
          endAt,
        }))
      ) {
        continue;
      }
      return { code, fingerprint, encrypted: this.cryptoService.encrypt(code) };
    }
    throw new ConflictException('Brak wolnego czterocyfrowego kodu dla tego terminu');
  }

  private async reserveCandidate(
    context: AccessCodeContext,
    candidate: Candidate,
    name: string | null,
    startAt: Date,
    endAt: Date,
    actor: ReservationActor,
    metadata: Record<string, unknown> = {},
  ): Promise<string | null> {
    try {
      return await this.withTransaction(async (client) => {
        await client.query(`SELECT id FROM apartment_access_devices WHERE id = $1 FOR UPDATE`, [
          context.accessDeviceId,
        ]);
        const conflict = await client.query(
          `
            SELECT 1
            FROM reservation_access_codes
            WHERE access_device_id = $1
              AND code_fingerprint = $2
              AND status <> 'revoked'
              AND valid_from < $4
              AND valid_until > $3
            LIMIT 1
          `,
          [
            context.accessDeviceId,
            candidate.fingerprint,
            startAt.toISOString(),
            endAt.toISOString(),
          ],
        );
        if (conflict.rows.length > 0) return null;

        const result = await client.query(
          `
            INSERT INTO reservation_access_codes (
              reservation_id,
              apartment_id,
              access_device_id,
              provider,
              code_ciphertext,
              code_fingerprint,
              code_name,
              valid_from,
              valid_until,
              status,
              metadata,
              created_by,
              updated_by
            )
            VALUES ($1, $2, $3, 'ttlock', $4, $5, $6, $7, $8, 'pending_create', $9::jsonb, $10, $10)
            RETURNING id
          `,
          [
            context.reservationId,
            context.apartmentId,
            context.accessDeviceId,
            candidate.encrypted,
            candidate.fingerprint,
            name,
            startAt.toISOString(),
            endAt.toISOString(),
            JSON.stringify(metadata),
            this.actorName(actor),
          ],
        );
        return result.rows[0].id as string;
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('Rezerwacja ma już aktywny kod dostępu');
      }
      throw error;
    }
  }

  private async prepareUpdate(params: {
    id: string;
    accessDeviceId: string;
    expectedVersion: number;
    encrypted: string;
    fingerprint: string;
    name: string | null;
    startAt: Date;
    endAt: Date;
    actor: ReservationActor;
    validitySource?: 'manual_override';
  }): Promise<number> {
    return this.withTransaction(async (client) => {
      await client.query(`SELECT id FROM apartment_access_devices WHERE id = $1 FOR UPDATE`, [
        params.accessDeviceId,
      ]);
      const conflict = await client.query(
        `
          SELECT 1
          FROM reservation_access_codes
          WHERE access_device_id = $1
            AND code_fingerprint = $2
            AND status <> 'revoked'
            AND valid_from < $4
            AND valid_until > $3
            AND id <> $5
          LIMIT 1
        `,
        [
          params.accessDeviceId,
          params.fingerprint,
          params.startAt.toISOString(),
          params.endAt.toISOString(),
          params.id,
        ],
      );
      if (conflict.rows.length > 0) {
        throw new ConflictException('Ten kod jest już używany w nakładającym się terminie');
      }

      const pending = await client.query(
        `
          UPDATE reservation_access_codes
          SET code_ciphertext = $3,
              code_fingerprint = $4,
              code_name = $5,
              valid_from = $6,
              valid_until = $7,
              status = 'pending_update',
              metadata = CASE
                WHEN $9::text IS NULL THEN metadata
                ELSE metadata || jsonb_build_object(
                  'validitySource', $9::text,
                  'manualOverrideAt', NOW()
                )
              END,
              updated_by = $8,
              updated_at = NOW(),
              version = version + 1,
              last_error = NULL
          WHERE id = $1 AND version = $2
          RETURNING version
        `,
        [
          params.id,
          params.expectedVersion,
          params.encrypted,
          params.fingerprint,
          params.name,
          params.startAt.toISOString(),
          params.endAt.toISOString(),
          this.actorName(params.actor),
          params.validitySource ?? null,
        ],
      );
      if (pending.rows.length === 0) {
        throw new ConflictException('Kod został w międzyczasie zmieniony. Odśwież dane.');
      }
      return Number(pending.rows[0].version);
    });
  }

  private async loadMutableRow(id: string): Promise<any> {
    const result = await this.pool.query(
      `
        SELECT
          code.*,
          device.provider_device_id,
          reservation.start_date AS stay_start_date,
          reservation.end_date AS stay_end_date
        FROM reservation_access_codes AS code
        JOIN apartment_access_devices AS device ON device.id = code.access_device_id
        JOIN reservations AS reservation ON reservation.id = code.reservation_id
        WHERE code.id = $1
      `,
      [id],
    );
    if (result.rows.length === 0) {
      throw new NotFoundException('Kod dostępu nie został znaleziony');
    }
    return result.rows[0];
  }

  private assertManualWindowMatchesStay(row: any, startAt: Date, endAt: Date): void {
    const metadata =
      typeof row.metadata === 'object' && row.metadata !== null ? row.metadata : {};
    const timeZone =
      typeof metadata.timeZone === 'string' ? metadata.timeZone : 'Europe/Warsaw';
    if (formatDateInTimeZone(startAt, timeZone) !== this.formatDate(row.stay_start_date)) {
      throw new BadRequestException(
        'Ręcznie można zmienić godzinę rozpoczęcia, ale nie dzień przyjazdu',
      );
    }
    if (formatDateInTimeZone(endAt, timeZone) !== this.formatDate(row.stay_end_date)) {
      throw new BadRequestException(
        'Ręcznie można zmienić godzinę zakończenia, ale nie dzień wyjazdu',
      );
    }
  }

  private async confirmProviderPasscode(params: {
    lockId: number;
    keyboardPwdId: number;
    passcode: string;
    startAt: Date;
    endAt: Date;
  }): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await this.ttlockService.isPasscodeConfigured(params)) return;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    throw new BadGatewayException(
      'TTLock przyjął operację, ale nie potwierdził kodu na liście zamka',
    );
  }

  private async markSyncError(
    id: string,
    error: unknown,
    actor: ReservationActor,
    eventType: string,
  ): Promise<void> {
    const message = this.errorMessage(error);
    await this.pool.query(
      `
        UPDATE reservation_access_codes
        SET status = 'sync_error', last_error = $2, updated_at = NOW()
        WHERE id = $1
      `,
      [id, message],
    );
    await this.recordEvent(id, eventType, actor, { error: message });
  }

  private async recordEvent(
    accessCodeId: string,
    eventType: string,
    actor: ReservationActor,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO access_code_audit_events (access_code_id, event_type, actor, details)
        VALUES ($1, $2, $3, $4::jsonb)
      `,
      [accessCodeId, eventType, this.actorName(actor), JSON.stringify(details)],
    );
  }

  private mapAccessCode(row: any): AccessCodeDto {
    const metadata =
      typeof row.metadata === 'object' && row.metadata !== null ? row.metadata : {};
    const validitySources = new Set(['apartment_default', 'manual_override', 'manual_draft']);
    const validitySource = validitySources.has(metadata.validitySource)
      ? metadata.validitySource
      : 'unknown';
    return {
      id: row.id,
      reservationId: row.reservation_id,
      apartmentId: row.apartment_id,
      apartmentName: row.apartment_name,
      accessDevice: {
        id: row.access_device_id,
        provider: 'ttlock',
        lockId: Number(row.provider_device_id),
        displayName: row.access_device_display_name ?? null,
      },
      guestName: row.guest_name ?? null,
      stayStartDate: this.formatDate(row.stay_start_date),
      stayEndDate: this.formatDate(row.stay_end_date),
      code: this.cryptoService.decrypt(row.code_ciphertext),
      name: row.code_name ?? null,
      validFrom: this.formatTimestamp(row.valid_from),
      validUntil: this.formatTimestamp(row.valid_until),
      validitySource,
      timeZone: typeof metadata.timeZone === 'string' ? metadata.timeZone : 'Europe/Warsaw',
      status: row.display_status ?? row.status,
      providerPasscodeId: row.provider_passcode_id ? Number(row.provider_passcode_id) : null,
      usageCount: row.usage_count === null ? null : Number(row.usage_count),
      firstUsedAt: row.first_used_at ? this.formatTimestamp(row.first_used_at) : null,
      lastUsedAt: row.last_used_at ? this.formatTimestamp(row.last_used_at) : null,
      usageSyncedAt: row.usage_synced_at ? this.formatTimestamp(row.usage_synced_at) : null,
      lastError: row.display_error ?? row.last_error ?? null,
      createdAt: this.formatTimestamp(row.created_at),
      updatedAt: this.formatTimestamp(row.updated_at),
      version: Number(row.version),
    };
  }

  private mapDraft(row: any): AccessCodeDraftDto {
    return {
      id: row.id,
      action: row.action,
      accessCodeId: row.access_code_id ?? null,
      appliedAccessCodeId: row.applied_access_code_id ?? null,
      reservationId: row.reservation_id,
      apartmentId: row.apartment_id,
      apartmentName: row.apartment_name,
      accessDevice: {
        id: row.access_device_id,
        provider: 'ttlock',
        lockId: Number(row.provider_device_id),
        displayName: row.access_device_display_name ?? null,
      },
      guestName: row.guest_name ?? null,
      code: this.cryptoService.decrypt(row.code_ciphertext),
      name: row.code_name ?? null,
      validFrom: this.formatTimestamp(row.valid_from),
      validUntil: this.formatTimestamp(row.valid_until),
      status: row.display_status ?? row.status,
      expiresAt: this.formatTimestamp(row.expires_at),
      lastError: row.last_error ?? null,
      version: Number(row.version),
      createdAt: this.formatTimestamp(row.created_at),
      updatedAt: this.formatTimestamp(row.updated_at),
    };
  }

  private assertDateRange(startAt: Date, endAt: Date): void {
    if (
      Number.isNaN(startAt.getTime()) ||
      Number.isNaN(endAt.getTime()) ||
      endAt.getTime() <= startAt.getTime()
    ) {
      throw new BadRequestException('Koniec ważności kodu musi być późniejszy niż początek');
    }
  }

  private batteryLevel(
    percentage: number | null,
  ): 'good' | 'low' | 'critical' | 'unknown' {
    if (percentage === null) return 'unknown';
    if (percentage <= 20) return 'critical';
    if (percentage <= 40) return 'low';
    return 'good';
  }

  private normalizeName(value: string | null | undefined): string | null {
    const normalized = value?.trim();
    return normalized ? normalized.slice(0, 100) : null;
  }

  private actorName(actor: ReservationActor): string {
    return actor.email || actor.id;
  }

  private errorMessage(error: unknown): string {
    return (error instanceof Error ? error.message : 'Nieznany błąd synchronizacji').slice(0, 1000);
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
  }

  private formatDate(value: Date | string): string {
    if (typeof value === 'string') return value.split('T')[0];
    return value.toISOString().slice(0, 10);
  }

  private formatTimestamp(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  private formatTime(value: Date | string): string {
    const text = String(value);
    const match = /^(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(text);
    if (!match) throw new BadRequestException('Nieprawidłowa godzina dostępu apartamentu');
    return match[1];
  }

  private async withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

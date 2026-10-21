import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { ReservationActor } from '../reservations/reservations.types';
import { TtlockService } from '../ttlock/ttlock.service';

export type LockMappingDto = {
  lockId: number;
  alias: string | null;
  apartmentId: string | null;
  apartmentName: string | null;
};

// Codes in these states still exist on (or are being written to) the lock, so
// the lock cannot silently move to another apartment underneath them.
const LIVE_CODE_STATUSES = ['pending_create', 'active', 'pending_update', 'pending_delete', 'sync_error'];

/**
 * Assigns TTLock apartment locks to apartments. Only apartment doors are managed:
 * the building entrance keeps a fixed code from the arrival message template.
 */
@Injectable()
export class LockMappingsService {
  private readonly logger = new Logger(LockMappingsService.name);

  constructor(
    @Inject('PG_POOL') private readonly pool: Pool,
    private readonly ttlockService: TtlockService,
  ) {}

  async setApartmentLock(
    apartmentId: string,
    lockId: number,
    actor: ReservationActor,
  ): Promise<LockMappingDto> {
    const [locks, apartmentResult] = await Promise.all([
      this.ttlockService.listLocks(),
      this.pool.query(`SELECT id, name FROM apartments WHERE id = $1`, [apartmentId]),
    ]);
    const lock = locks.find((candidate) => candidate.lockId === lockId);
    if (!lock) throw new NotFoundException('Zamek nie istnieje na koncie TTLock');
    const apartment = apartmentResult.rows[0];
    if (!apartment) throw new NotFoundException('Apartament nie został znaleziony');

    await this.withTransaction(async (client) => {
      // Serialize mapping changes; the unique index allows one active lock per apartment.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('ttlock-lock-mappings'))`);
      const current = await client.query(
        `SELECT id, provider_device_id FROM apartment_access_devices
         WHERE apartment_id = $1 AND provider = 'ttlock' AND scope = 'apartment' AND active = true`,
        [apartmentId],
      );
      const existing = await client.query(
        `SELECT id, apartment_id, scope, active FROM apartment_access_devices
         WHERE provider = 'ttlock' AND provider_device_id = $1`,
        [lockId],
      );
      const device = existing.rows[0];
      const unchanged =
        device?.active && device.scope === 'apartment' && device.apartment_id === apartmentId;
      if (unchanged) return;

      if (device?.active) await this.assertNoLiveCodes(client, device.id, 'Ten zamek');
      for (const row of current.rows) {
        await this.assertNoLiveCodes(client, row.id, 'Obecny zamek apartamentu');
        await client.query(
          `UPDATE apartment_access_devices SET active = false, updated_at = NOW() WHERE id = $1`,
          [row.id],
        );
      }

      if (device) {
        await client.query(
          `UPDATE apartment_access_devices SET
             apartment_id = $2, scope = 'apartment', active = true,
             display_name = COALESCE($3, display_name), updated_at = NOW()
           WHERE id = $1`,
          [device.id, apartmentId, lock.alias],
        );
      } else {
        await client.query(
          `INSERT INTO apartment_access_devices (
             apartment_id, provider, provider_device_id, scope, display_name
           ) VALUES ($1, 'ttlock', $2, 'apartment', $3)`,
          [apartmentId, lockId, lock.alias],
        );
      }
    });

    this.logger.log(
      `Zamek TTLock ${lockId} przypisany do apartamentu ${apartment.name} (${actor.email ?? actor.id})`,
    );
    return { lockId, alias: lock.alias, apartmentId, apartmentName: apartment.name };
  }

  private async assertNoLiveCodes(client: PoolClient, deviceId: string, subject: string): Promise<void> {
    const codes = await client.query(
      `SELECT COUNT(*)::int AS count FROM reservation_access_codes
       WHERE access_device_id = $1 AND status = ANY($2::text[])`,
      [deviceId, LIVE_CODE_STATUSES],
    );
    if (codes.rows[0].count > 0) {
      throw new ConflictException(
        `${subject} ma aktywne kody gości. Usuń je przed zmianą przypisania zamka.`,
      );
    }
  }

  private async withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

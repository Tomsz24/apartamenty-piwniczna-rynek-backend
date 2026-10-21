import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';

export interface ApartmentDto {
  id: string;
  name: string | null;
  description: string | null;
  accessCodeCheckInTime: string;
  accessCodeCheckOutTime: string;
  accessCodeTimeZone: string;
}

@Injectable()
export class ApartmentsService {
  constructor(@Inject('PG_POOL') private readonly pool: Pool) {}

  async list(): Promise<ApartmentDto[]> {
    const result = await this.pool.query(
      `SELECT id, name, description, access_code_check_in_time,
              access_code_check_out_time, access_code_time_zone
       FROM apartments
       ORDER BY name NULLS LAST, id`,
    );

    return result.rows.map((row) => ({
      id: row.id,
      name: row.name ?? null,
      description: row.description ?? null,
      accessCodeCheckInTime: this.formatTime(row.access_code_check_in_time),
      accessCodeCheckOutTime: this.formatTime(row.access_code_check_out_time),
      accessCodeTimeZone: row.access_code_time_zone,
    }));
  }

  private formatTime(value: string | Date): string {
    return typeof value === 'string' ? value.slice(0, 5) : value.toISOString().slice(11, 16);
  }
}

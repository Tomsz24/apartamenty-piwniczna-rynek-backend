import { Controller, Get, Inject, UseGuards, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { SupabaseAdminGuard } from '../auth/supabase-admin.guard';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@Inject('PG_POOL') private readonly pgPool: Pool) {}

  @Get()
  checkLiveness() {
    return { status: 'ok' };
  }

  @Get('ready')
  @UseGuards(SupabaseAdminGuard)
  async checkReadiness() {
    await this.pgPool.query('SELECT 1');
    return { status: 'ok', database: 'ok' };
  }

  @Get('db')
  @UseGuards(SupabaseAdminGuard)
  async checkDB() {
    const result = await this.pgPool.query('SELECT 1 as ok');
    this.logger.log('DB check ok');
    return { status: 'ok', db: result.rows[0] };
  }
}

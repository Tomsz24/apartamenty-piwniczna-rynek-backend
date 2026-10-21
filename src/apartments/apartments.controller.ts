import { Controller, Get, UseGuards } from '@nestjs/common';
import { SupabaseAdminGuard } from '../auth/supabase-admin.guard';
import { ApartmentsService } from './apartments.service';

@Controller('apartments')
@UseGuards(SupabaseAdminGuard)
export class ApartmentsController {
  constructor(private readonly apartmentsService: ApartmentsService) {}

  @Get()
  list() {
    return this.apartmentsService.list();
  }
}

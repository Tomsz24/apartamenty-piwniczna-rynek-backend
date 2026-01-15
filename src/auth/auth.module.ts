import { Module } from '@nestjs/common';
import { SupabaseAdminGuard} from './supabase-admin.guard';

@Module({
  providers: [SupabaseAdminGuard],
  exports: [SupabaseAdminGuard],
})
export class AuthModule {}

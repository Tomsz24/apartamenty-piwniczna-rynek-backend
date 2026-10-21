import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';

@Global()
@Module({
  providers: [
    {
      provide: 'PG_POOL',
      useFactory: () => {
        const databaseUrl = process.env.DATABASE_URL;
        return new Pool({
          connectionString: databaseUrl,
          ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
        });
      },
    },
  ],
  exports: ['PG_POOL'],
})
export class DatabaseModule {}

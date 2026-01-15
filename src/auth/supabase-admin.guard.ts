import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';

type SupabaseUserResponse = {
  id: string;
  email?: string;
  role?: string;
  aud?: string;
};

@Injectable()
export class SupabaseAdminGuard implements CanActivate {
  private readonly logger = new Logger(SupabaseAdminGuard.name);

  private readonly supabaseUrl: string;
  private readonly supabasePublishableKey: string;
  private readonly adminEmails: Set<string>;

  constructor() {
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!supabaseUrl) throw new Error('Brak SUPABASE_URL w .env');

    const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!supabasePublishableKey) {
      throw new Error('Brak SUPABASE_PUBLISHABLE_KEY w .env');
    }

    const admins = (process.env.ADMIN_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    this.supabaseUrl = supabaseUrl;
    this.supabasePublishableKey = supabasePublishableKey;
    this.adminEmails = new Set(admins);

    this.logger.log(`Supabase URL: ${this.supabaseUrl}`);
    this.logger.log(`Admins: ${admins.join(', ') || '(none)'}`);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<any>();
    const auth = req.headers?.authorization as string | undefined;

    if (!auth?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Brak Authorization: Bearer <token>');
    }

    const accessToken = auth.slice('Bearer '.length).trim();

    const user = await this.fetchSupabaseUser(accessToken);

    const email = (user.email || '').toLowerCase();
    if (!email) {
      throw new ForbiddenException('Brak email w danych użytkownika Supabase');
    }

    if (!this.adminEmails.has(email)) {
      throw new ForbiddenException('Brak uprawnień administratora');
    }

    req.user = { id: user.id, email };
    return true;
  }

  private async fetchSupabaseUser(accessToken: string): Promise<SupabaseUserResponse> {
    const url = new URL('/auth/v1/user', this.supabaseUrl);

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        apikey: this.supabasePublishableKey,
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.warn(
        `Supabase /auth/v1/user rejected token: status=${res.status} body=${body}`,
      );
      throw new UnauthorizedException('Nieprawidłowy lub wygasły token');
    }

    return (await res.json()) as SupabaseUserResponse;
  }
}

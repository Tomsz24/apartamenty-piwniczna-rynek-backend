import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  NotFoundException,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { parseHostexWebhook } from './hostex-webhook.domain';
import { HostexWebhookService } from './hostex-webhook.service';

// Public endpoint called by Hostex; authenticated only by the webhook secret
// header, so it deliberately lives outside the admin-guarded HostexController.
@Controller('hostex/webhook')
export class HostexWebhookController {
  constructor(private readonly webhookService: HostexWebhookService) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Headers('hostex-webhook-secret-token') secretToken: string | undefined,
    @Body() body: Record<string, unknown>,
  ): Promise<{ received: true; duplicate: boolean }> {
    if (!this.webhookService.isEnabled()) throw new NotFoundException();
    if (!this.webhookService.verifySecret(secretToken)) {
      throw new UnauthorizedException('Nieprawidłowy sekret webhooka');
    }
    const event = parseHostexWebhook(body);
    if (!event) throw new BadRequestException('Nieprawidłowe zdarzenie Hostex');
    const { duplicate } = await this.webhookService.receive(event);
    return { received: true, duplicate };
  }
}

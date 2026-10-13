import { Body, Controller, HttpCode, Inject, Logger, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../../common/decorators/public.decorator.js';
import { SkipCsrf } from '../../../common/decorators/skip-csrf.decorator.js';
import { snsAlertsConfig, type SnsAlertsConfig } from '../../../config/sns-alerts.config.js';
import { adaptAmpAlertMessage } from '../adapters/amp/amp-alert.adapter.js';
import { AlertService } from '../alert.service.js';
import { AlertInputError, SnsSignatureError } from '../alert.types.js';
import { SnsMessageVerifier } from './sns-message.verifier.js';
import { SnsConfirmationService } from './sns-confirmation.service.js';

@Controller('alerts')
export class SnsAlertsController {
  private readonly logger = new Logger(SnsAlertsController.name);
  constructor(@Inject(snsAlertsConfig.KEY) private readonly config: SnsAlertsConfig,
    private readonly verifier: SnsMessageVerifier, private readonly confirmation: SnsConfirmationService,
    private readonly alerts: AlertService) {}

  @Post('sns')
  @Public()
  @SkipCsrf()
  @HttpCode(200)
  async receive(@Body() input: unknown, @Res() response: Response): Promise<void> {
    if (response.headersSent || response.destroyed) return;
    response.setHeader('Cache-Control', 'no-store');
    const deadlineAt = typeof response.locals.snsDeadlineAt === 'number' ? response.locals.snsDeadlineAt : Date.now() + 10_000;
    const remaining = deadlineAt - Date.now();
    if (!this.config.enabled || remaining <= 0) { response.status(503).json({ code: 'ALERTS_UNAVAILABLE' }); return; }
    const signal = AbortSignal.timeout(remaining);
    try {
      const envelope = await this.verifier.verify(input, signal);
      if (envelope.Type === 'SubscriptionConfirmation') {
        await this.confirmation.confirm(envelope, signal);
        this.logger.log({ code: 'SNS_SUBSCRIPTION_CONFIRMED' });
      } else if (envelope.Type === 'UnsubscribeConfirmation') {
        this.logger.warn({ code: 'SNS_UNSUBSCRIBE_CONFIRMED' });
      } else {
        const result = await this.alerts.ingest(adaptAmpAlertMessage(envelope.Message), deadlineAt);
        this.logger.log({ code: 'ALERT_BATCH_COMMITTED', ...result });
      }
      if (!signal.aborted && !response.headersSent && !response.destroyed) response.status(200).json({ accepted: true });
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const status = error instanceof AlertInputError ? 400 : error instanceof SnsSignatureError ? 403 : 503;
      const code = status === 400 ? 'ALERT_INPUT_INVALID' : status === 403 ? 'SNS_VERIFICATION_FAILED' : 'ALERTS_UNAVAILABLE';
      if (status === 503) this.logger.warn({ code });
      response.status(status).json({ code });
    }
  }
}

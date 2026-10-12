import { Inject, Injectable } from '@nestjs/common';
import { SNSClient, ConfirmSubscriptionCommand } from '@aws-sdk/client-sns';
import { snsAlertsConfig, type SnsAlertsConfig } from '../../../config/sns-alerts.config.js';
import { AlertUnavailableError } from '../alert.types.js';
import type { VerifiedSnsEnvelope } from './sns-envelope.js';

@Injectable()
export class SnsConfirmationService {
  private client: SNSClient | undefined;
  constructor(@Inject(snsAlertsConfig.KEY) private readonly config: SnsAlertsConfig) {}
  async confirm(envelope: Extract<VerifiedSnsEnvelope, { Type: 'SubscriptionConfirmation' }>, signal: AbortSignal): Promise<void> {
    if (!this.config.enabled || signal.aborted || envelope.TopicArn !== this.config.topicArn) throw new AlertUnavailableError();
    this.client ??= new SNSClient({ region: this.config.region, maxAttempts: 2 });
    try {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
      const result = await this.client.send(new ConfirmSubscriptionCommand({
        TopicArn: this.config.topicArn, Token: envelope.Token, AuthenticateOnUnsubscribe: 'true',
      }), { abortSignal: bounded });
      if (bounded.aborted || !result.SubscriptionArn || result.SubscriptionArn === 'pending confirmation') throw new AlertUnavailableError();
    } catch { throw new AlertUnavailableError(); }
  }
}

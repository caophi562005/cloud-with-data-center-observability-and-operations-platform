import { Inject, Injectable } from '@nestjs/common';
import { constants, verify } from 'node:crypto';
import { snsAlertsConfig, type SnsAlertsConfig } from '../../../config/sns-alerts.config.js';
import { AlertUnavailableError, SnsSignatureError } from '../alert.types.js';
import { SnsCertificateProvider } from './sns-certificate.provider.js';
import { buildSnsSigningString, parseSnsEnvelope, type VerifiedSnsEnvelope } from './sns-envelope.js';

@Injectable()
export class SnsMessageVerifier {
  constructor(@Inject(snsAlertsConfig.KEY) private readonly config: SnsAlertsConfig, private readonly certificates: SnsCertificateProvider) {}
  async verify(input: unknown, signal: AbortSignal): Promise<VerifiedSnsEnvelope> {
    if (!this.config.enabled || signal.aborted) throw new AlertUnavailableError();
    const envelope = parseSnsEnvelope(input);
    if (envelope.TopicArn !== this.config.topicArn) throw new SnsSignatureError();
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.Signature)) throw new SnsSignatureError();
    const signature = Buffer.from(envelope.Signature, 'base64');
    if (!signature.length || signature.toString('base64') !== envelope.Signature) throw new SnsSignatureError();
    const key = await this.certificates.getSigningKey(envelope.SigningCertURL, signal);
    try {
      if (!verify(envelope.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256', Buffer.from(buildSnsSigningString(envelope), 'utf8'),
        { key: key.publicKey, padding: constants.RSA_PKCS1_PADDING }, signature)) throw new SnsSignatureError();
    } catch { throw new SnsSignatureError(); }
    if (signal.aborted) throw new AlertUnavailableError();
    return envelope as VerifiedSnsEnvelope;
  }
}

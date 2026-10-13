import { Inject, Injectable } from '@nestjs/common';
import { get } from 'node:https';
import { X509Certificate, type KeyObject } from 'node:crypto';
import { snsAlertsConfig, type SnsAlertsConfig } from '../../../config/sns-alerts.config.js';
import { AlertUnavailableError, SnsSignatureError } from '../alert.types.js';

export type TrustedSnsSigningKey = Readonly<{ publicKey: KeyObject; notBefore: number; notAfter: number; provenanceUrl: string }>;
@Injectable()
export class SnsCertificateProvider {
  private readonly cache = new Map<string, { key: TrustedSnsSigningKey; expires: number }>();
  constructor(@Inject(snsAlertsConfig.KEY) private readonly config: SnsAlertsConfig) {}

  async getSigningKey(signingCertUrl: string, signal: AbortSignal): Promise<TrustedSnsSigningKey> {
    if (!this.config.enabled || signal.aborted) throw new AlertUnavailableError();
    let url: URL;
    try { url = new URL(signingCertUrl); } catch { throw new SnsSignatureError(); }
    if (url.protocol !== 'https:' || url.hostname !== `sns.${this.config.region}.amazonaws.com` ||
      url.username || url.password || (url.port && url.port !== '443') ||
      signingCertUrl.includes('?') || signingCertUrl.includes('#') ||
      !/^\/SimpleNotificationService-[A-Za-z0-9_-]+\.pem$/.test(url.pathname)) throw new SnsSignatureError();
    const cached = this.cache.get(url.href);
    const now = Date.now();
    if (cached && cached.expires > now && cached.key.notBefore <= now) return cached.key;
    this.cache.delete(url.href);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
    // Trust anchor: authenticated TLS retrieval from the exact AWS-owned SNS
    // publishing endpoint. X509 parsing below alone does NOT validate issuer chain.
    const pem = await new Promise<Buffer>((resolve, reject) => {
      const request = get(url, { signal: bounded, rejectUnauthorized: true }, (response) => {
        if (response.statusCode !== 200) { response.destroy(); reject(new AlertUnavailableError()); return; }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 65536) { response.destroy(); reject(new SnsSignatureError()); return; }
          chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', () => reject(new AlertUnavailableError()));
        response.on('aborted', () => reject(new AlertUnavailableError()));
      });
      request.on('error', () => reject(new AlertUnavailableError()));
    });
    let key: TrustedSnsSigningKey;
    try {
      const certificate = new X509Certificate(pem);
      key = { publicKey: certificate.publicKey, notBefore: Date.parse(certificate.validFrom), notAfter: Date.parse(certificate.validTo), provenanceUrl: url.href };
      if (!Number.isFinite(key.notBefore) || !Number.isFinite(key.notAfter) || key.notBefore > Date.now() || key.notAfter <= Date.now() ||
        key.publicKey.asymmetricKeyType !== 'rsa' || (key.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new SnsSignatureError();
    } catch { throw new SnsSignatureError(); }
    if (bounded.aborted) throw new AlertUnavailableError();
    while (this.cache.size >= 16) { const oldest = this.cache.keys().next().value; if (oldest !== undefined) this.cache.delete(oldest); }
    this.cache.set(url.href, { key, expires: Math.min(Date.now() + 6 * 60 * 60 * 1000, key.notAfter) });
    return key;
  }
}

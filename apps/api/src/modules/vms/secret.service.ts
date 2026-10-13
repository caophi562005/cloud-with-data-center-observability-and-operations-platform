import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';

export type SecretPrefix = 'ENR_' | 'AGT_';

export type GeneratedSecret = {
  value: string;
  hash: string;
};

@Injectable()
export class SecretService {
  generate(prefix: SecretPrefix): GeneratedSecret {
    const value = `${prefix}${randomBytes(32).toString('base64url')}`;

    return {
      value,
      hash: this.hash(value),
    };
  }

  hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }
}

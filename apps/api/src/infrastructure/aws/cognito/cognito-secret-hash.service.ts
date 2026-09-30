import { Inject, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { authConfig, type AuthConfig } from '../../../config/auth.config.js';

@Injectable()
export class CognitoSecretHashService {
  constructor(@Inject(authConfig.KEY) private readonly config: AuthConfig) {}

  calculate(username: string): string | undefined {
    if (!this.config.clientSecret) {
      return undefined;
    }

    return createHmac('sha256', this.config.clientSecret)
      .update(`${username}${this.config.clientId}`, 'utf8')
      .digest('base64');
  }
}

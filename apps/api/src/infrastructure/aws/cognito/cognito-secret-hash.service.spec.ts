import { describe, expect, it } from 'vitest';
import { CognitoSecretHashService } from './cognito-secret-hash.service.js';

describe('CognitoSecretHashService', () => {
  it('calculates the Base64 HMAC-SHA256 Cognito secret hash', () => {
    const service = new CognitoSecretHashService({
      region: 'ap-southeast-1',
      userPoolId: 'ap-southeast-1_example',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });

    expect(service.calculate('admin@example.com')).toBe(
      '98ZPVquY3OpS4HbTpuMB2BzhAXqjhGV7aWQR/+YRV+A=',
    );
  });

  it('returns undefined for a public Cognito client', () => {
    const service = new CognitoSecretHashService({
      region: 'ap-southeast-1',
      userPoolId: 'ap-southeast-1_example',
      clientId: 'client-id',
      clientSecret: undefined,
    });

    expect(service.calculate('admin@example.com')).toBeUndefined();
  });
});

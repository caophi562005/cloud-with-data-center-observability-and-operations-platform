import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretService } from './secret.service.js';

describe('SecretService', () => {
  it('generates a 32-byte prefixed enrollment secret and its hash', () => {
    const service = new SecretService();
    const generated = service.generate('ENR_');

    expect(generated.value).toMatch(/^ENR_[A-Za-z0-9_-]{43}$/);
    expect(generated.hash).toBe(service.hash(generated.value));
    expect(generated.hash).toBe(
      createHash('sha256').update(generated.value).digest('hex'),
    );
    expect(generated.hash).not.toBe(generated.value);
  });

  it('supports agent credentials with a distinct prefix', () => {
    const generated = new SecretService().generate('AGT_');

    expect(generated.value).toMatch(/^AGT_[A-Za-z0-9_-]{43}$/);
  });

  it('hashes the complete prefixed plaintext deterministically', () => {
    const service = new SecretService();

    expect(service.hash('ENR_test')).toBe(
      createHash('sha256').update('ENR_test').digest('hex'),
    );
    expect(service.hash('ENR_test')).not.toBe(service.hash('test'));
  });
});

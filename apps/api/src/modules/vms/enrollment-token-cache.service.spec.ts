import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheService } from '../../infrastructure/cache/cache.service.js';
import { EnrollmentTokenCacheService } from './enrollment-token-cache.service.js';

const NOW = new Date('2026-10-03T00:00:00Z');
const TOKEN = {
  tokenId: 'token-1',
  token: `ENR_${'a'.repeat(43)}`,
  expiresAt: new Date(NOW.getTime() + 60_000),
};
function fixture(key: string | undefined = 'ab'.repeat(32)) {
  const entries = new Map<string, unknown>();
  const cache = {
    get: vi.fn(
      async (key: string): Promise<unknown> => entries.get(key) ?? null,
    ),
    setUntil: vi.fn(async (key: string, value: unknown) => {
      entries.set(key, value);
    }),
    deleteByPrefix: vi.fn(),
  };
  const service = new EnrollmentTokenCacheService(
    cache as unknown as CacheService,
    { get: () => key } as unknown as ConfigService,
  );
  return { service, cache, entries };
}
describe('EnrollmentTokenCacheService', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => vi.useRealTimers());
  it('caps TTL at 24 hours and does not renew it on reads', async () => {
    const { service, cache } = fixture();
    await service.set(
      'org',
      'vm',
      { ...TOKEN, expiresAt: new Date(NOW.getTime() + 172_800_000) },
      NOW,
    );
    expect(cache.setUntil).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      new Date(NOW.getTime() + 86_400_000),
    );
    await service.get('org', 'vm', 'token-1', NOW);
    expect(cache.setUntil).toHaveBeenCalledTimes(1);
  });
  it('rejects ciphertext after changing the encryption key', async () => {
    const { service, cache } = fixture();
    await service.set('org', 'vm', TOKEN, NOW);
    const rotated = new EnrollmentTokenCacheService(
      cache as unknown as CacheService,
      { get: () => 'cd'.repeat(32) } as unknown as ConfigService,
    );
    expect(await rotated.get('org', 'vm', 'token-1', NOW)).toBeNull();
  });
  it('bounds a stalled cache read and write without blocking issuance', async () => {
    vi.useFakeTimers();
    const { service, cache } = fixture();
    cache.get.mockImplementationOnce(() => new Promise(() => {}));
    const reading = service.get('org', 'vm', 'token-1', NOW);
    await vi.advanceTimersByTimeAsync(500);
    expect(await reading).toBeNull();
    cache.setUntil.mockImplementationOnce(() => new Promise(() => {}));
    const writing = service.set('org', 'vm', TOKEN, NOW);
    await vi.advanceTimersByTimeAsync(500);
    await expect(writing).resolves.toBeUndefined();
  });
  it('rejects a token that expires before the Redis read completes', async () => {
    vi.useFakeTimers({ now: NOW });
    const { service, cache, entries } = fixture();
    await service.set('org', 'vm', TOKEN, NOW);
    vi.setSystemTime(new Date(TOKEN.expiresAt.getTime() - 100));
    cache.get.mockImplementationOnce(async (key) => {
      const value = entries.get(key);
      await new Promise((resolve) => setTimeout(resolve, 250));
      return value;
    });
    const reading = service.get('org', 'vm', 'token-1');
    await vi.advanceTimersByTimeAsync(250);
    expect(await reading).toBeNull();
  });
  it('encrypts token with a remaining TTL and decrypts only for the same scope', async () => {
    const { service, cache, entries } = fixture();
    await service.set('org', 'vm', TOKEN, NOW);
    expect(cache.setUntil).toHaveBeenCalledWith(
      expect.stringContaining('org:vm:token-1'),
      expect.any(Object),
      TOKEN.expiresAt,
    );
    expect(JSON.stringify([...entries.values()])).not.toContain(TOKEN.token);
    expect(await service.get('org', 'vm', 'token-1', NOW)).toEqual(TOKEN);
    const value = [...entries.values()][0];
    entries.set('vm-enrollment:v1:other:vm:token-1', value);
    expect(await service.get('other', 'vm', 'token-1', NOW)).toBeNull();
  });
  it('rejects corrupted ciphertext, changed keys and expired tokens', async () => {
    const { service, entries } = fixture();
    await service.set('org', 'vm', TOKEN, NOW);
    expect(
      await service.get('org', 'vm', 'token-1', TOKEN.expiresAt),
    ).toBeNull();
    const cacheKey = [...entries.keys()][0];
    const envelope = entries.get(cacheKey) as { ciphertext: string };
    entries.set(cacheKey, { ...envelope, ciphertext: 'AAAA' });
    expect(await service.get('org', 'vm', 'token-1', NOW)).toBeNull();
  });
  it('does not cache AGT credentials or expired tokens', async () => {
    const { service, cache } = fixture();
    await service.set(
      'org',
      'vm',
      { ...TOKEN, token: `AGT_${'a'.repeat(43)}` },
      NOW,
    );
    await service.set('org', 'vm', TOKEN, TOKEN.expiresAt);
    expect(cache.setUntil).not.toHaveBeenCalled();
  });
  it('disables cache when no encryption key is configured and fails safely on cache errors', async () => {
    const disabled = fixture(undefined);
    // Explicit undefined uses the fixture default, so provide a config without a key.
    const service = new EnrollmentTokenCacheService(
      disabled.cache as unknown as CacheService,
      { get: () => undefined } as unknown as ConfigService,
    );
    await service.set('org', 'vm', TOKEN, NOW);
    expect(await service.get('org', 'vm', 'token-1', NOW)).toBeNull();
    expect(disabled.cache.setUntil).not.toHaveBeenCalled();
    const enabled = fixture();
    enabled.cache.get.mockRejectedValueOnce(new Error('unavailable'));
    expect(await enabled.service.get('org', 'vm', 'token-1', NOW)).toBeNull();
  });
  it('invalidates only the enrolled VM scope', async () => {
    const { service, cache } = fixture();
    await service.invalidate('org', 'vm');
    expect(cache.deleteByPrefix).toHaveBeenCalledWith(
      'vm-enrollment:v1:org:vm:',
    );
  });
});

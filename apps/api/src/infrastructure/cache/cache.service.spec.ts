import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CacheService } from './cache.service.js';
import type { RedisService } from './redis.service.js';

type RedisMock = {
  get: ReturnType<typeof vi.fn<(key: string) => Promise<string | null>>>;
  set: ReturnType<
    typeof vi.fn<
      (key: string, value: string, options: { EX: number }) => Promise<unknown>
    >
  >;
  del: ReturnType<typeof vi.fn<(...keys: string[]) => Promise<unknown>>>;
  scanIterator: ReturnType<
    typeof vi.fn<(options?: { MATCH?: string }) => AsyncIterable<unknown>>
  >;
};

function makeRedisMock(): RedisMock {
  return {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    scanIterator: vi.fn(),
  };
}

describe('CacheService', () => {
  it('returns a typed cached value after JSON deserialization', async () => {
    const redisMock = makeRedisMock();
    redisMock.get.mockResolvedValue(JSON.stringify({ role: 'ADMIN' }));
    const cache = new CacheService(redisMock);

    await expect(cache.get<{ role: string }>('key')).resolves.toEqual({
      role: 'ADMIN',
    });
  });

  it('returns a cache miss when Redis reads fail', async () => {
    const redisMock = makeRedisMock();
    redisMock.get.mockRejectedValue(new Error('connection refused'));
    const cache = new CacheService(redisMock);

    await expect(cache.get('key')).resolves.toBeNull();
  });

  it('emits one redacted warning when a Redis read fails', async () => {
    const redisMock = makeRedisMock();
    redisMock.get.mockRejectedValue(
      new Error(
        'REDIS_URL=redis://user:password@example.test token=access-token key=secret-key',
      ),
    );
    const cache = new CacheService(redisMock);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      return undefined;
    });

    try {
      await expect(
        cache.get('cloudops:v1:membership:user-secret:org-secret'),
      ).resolves.toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const warning = JSON.stringify(warn.mock.calls);
      expect(warning).not.toContain('redis://');
      expect(warning).not.toContain('access-token');
      expect(warning).not.toContain('user-secret');
      expect(warning).not.toContain('org-secret');
    } finally {
      warn.mockRestore();
    }
  });

  it('serializes values and forwards the EX TTL', async () => {
    const redisMock = makeRedisMock();
    const cache = new CacheService(redisMock);

    await cache.set('key', { role: 'ADMIN' }, 60);

    expect(redisMock.set).toHaveBeenCalledWith(
      'key',
      JSON.stringify({ role: 'ADMIN' }),
      { EX: 60 },
    );
  });

  it('warns and swallows Redis client acquisition failures on writes', async () => {
    const cache = new CacheService({
      getClient: () => {
        throw new Error(
          'REDIS_URL=redis://user:password@example.test token=write-token',
        );
      },
    } as unknown as RedisService);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      return undefined;
    });

    try {
      await expect(
        cache.set('cloudops:v1:secret-key', { value: 'secret' }, 60),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      const warning = JSON.stringify(warn.mock.calls);
      expect(warning).not.toContain('redis://');
      expect(warning).not.toContain('write-token');
      expect(warning).not.toContain('secret-key');
    } finally {
      warn.mockRestore();
    }
  });

  it('warns and swallows serialization failures on writes', async () => {
    const redisMock = makeRedisMock();
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const cache = new CacheService(redisMock);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      return undefined;
    });

    try {
      await expect(
        cache.set('cloudops:v1:secret-key', circular, 60),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-key');
    } finally {
      warn.mockRestore();
    }
  });

  it('deletes the requested keys without throwing when Redis is unavailable', async () => {
    const redisMock = makeRedisMock();
    redisMock.del.mockRejectedValue(new Error('connection refused'));
    const cache = new CacheService(redisMock);

    await expect(cache.delete('one', 'two')).resolves.toBeUndefined();
    expect(redisMock.del).toHaveBeenCalledWith('one', 'two');
  });

  it('emits one redacted warning when Redis key deletion fails', async () => {
    const redisMock = makeRedisMock();
    redisMock.del.mockRejectedValue(
      new Error(
        'REDIS_URL=redis://user:password@example.test token=refresh-token',
      ),
    );
    const cache = new CacheService(redisMock);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      return undefined;
    });

    try {
      await expect(
        cache.delete('cloudops:v1:membership:user-secret:org-secret'),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      const warning = JSON.stringify(warn.mock.calls);
      expect(warning).not.toContain('redis://');
      expect(warning).not.toContain('refresh-token');
      expect(warning).not.toContain('user-secret');
      expect(warning).not.toContain('org-secret');
    } finally {
      warn.mockRestore();
    }
  });

  it('invalidates all keys found by a SCAN prefix query', async () => {
    const redisMock = makeRedisMock();
    redisMock.scanIterator.mockReturnValue(
      (async function* () {
        yield ['cloudops:v1:members:one', 'cloudops:v1:members:two'];
        yield ['cloudops:v1:members:three'];
      })(),
    );
    const cache = new CacheService(redisMock);

    await cache.deleteByPrefix('cloudops:v1:members:');

    expect(redisMock.scanIterator).toHaveBeenCalledWith({
      MATCH: 'cloudops:v1:members:*',
    });
    expect(redisMock.del).toHaveBeenNthCalledWith(
      1,
      'cloudops:v1:members:one',
      'cloudops:v1:members:two',
    );
    expect(redisMock.del).toHaveBeenNthCalledWith(
      2,
      'cloudops:v1:members:three',
    );
  });

  it('escapes Redis glob metacharacters in literal prefixes', async () => {
    const redisMock = makeRedisMock();
    redisMock.scanIterator.mockReturnValue(
      (async function* () {
        yield [];
      })(),
    );
    const cache = new CacheService(redisMock);

    await cache.deleteByPrefix('cloudops:*?[]\\');

    expect(redisMock.scanIterator).toHaveBeenCalledWith({
      MATCH: 'cloudops:\\*\\?\\[\\]\\\\*',
    });
  });

  it('chunks oversized SCAN pages into bounded DEL calls', async () => {
    const redisMock = makeRedisMock();
    const keys = Array.from(
      { length: 101 },
      (_, index) => `cloudops:v1:key:${index}`,
    );
    redisMock.scanIterator.mockReturnValue(
      (async function* () {
        yield keys;
      })(),
    );
    const cache = new CacheService(redisMock);

    await cache.deleteByPrefix('cloudops:v1:');

    expect(redisMock.del).toHaveBeenCalledTimes(2);
    expect(redisMock.del.mock.calls[0]).toHaveLength(100);
    expect(redisMock.del.mock.calls[1]).toEqual(['cloudops:v1:key:100']);
  });

  it('swallows Redis errors while invalidating a prefix', async () => {
    const redisMock = makeRedisMock();
    redisMock.scanIterator.mockImplementation(() => {
      throw new Error('connection refused');
    });
    const cache = new CacheService(redisMock);

    await expect(cache.deleteByPrefix('cloudops:v1:')).resolves.toBeUndefined();
  });

  it('emits one redacted warning when Redis prefix invalidation fails', async () => {
    const redisMock = makeRedisMock();
    redisMock.scanIterator.mockImplementation(() => {
      throw new Error(
        'REDIS_URL=redis://user:password@example.test key=secret-key',
      );
    });
    const cache = new CacheService(redisMock);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      return undefined;
    });

    try {
      await expect(
        cache.deleteByPrefix('cloudops:v1:me:user-secret'),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      const warning = JSON.stringify(warn.mock.calls);
      expect(warning).not.toContain('redis://');
      expect(warning).not.toContain('secret-key');
      expect(warning).not.toContain('user-secret');
    } finally {
      warn.mockRestore();
    }
  });
});

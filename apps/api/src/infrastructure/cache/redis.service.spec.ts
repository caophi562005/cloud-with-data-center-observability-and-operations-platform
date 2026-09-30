import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from 'redis';
import { RedisService } from './redis.service.js';

vi.mock('redis', () => ({
  createClient: vi.fn(),
}));

type RedisClientMock = {
  connect: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  isOpen: boolean;
  isReady: boolean;
};

const createClientMock = vi.mocked(createClient);

function makeRedisClient(): RedisClientMock {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue('OK'),
    destroy: vi.fn(),
    ping: vi.fn().mockResolvedValue('PONG'),
    on: vi.fn(),
    isOpen: false,
    isReady: false,
  };
}

describe('RedisService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates the official Redis client and connects only once', async () => {
    const client = makeRedisClient();
    createClientMock.mockReturnValue(client as never);
    const configService = {
      getOrThrow: vi.fn().mockReturnValue('redis://localhost:6379'),
    };
    const service = new RedisService(configService as never);

    expect(createClientMock).toHaveBeenCalledWith({
      url: 'redis://localhost:6379',
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 5_000,
        reconnectStrategy: false,
      },
    });

    await service.onModuleInit();
    await service.onModuleInit();

    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('reports Redis health with PING without throwing on failure', async () => {
    const client = makeRedisClient();
    client.isReady = true;
    createClientMock.mockReturnValue(client as never);
    const service = new RedisService({
      getOrThrow: vi.fn().mockReturnValue('redis://localhost:6379'),
    } as never);

    await expect(service.ping()).resolves.toBe(true);
    client.ping.mockRejectedValueOnce(new Error('unavailable'));
    await expect(service.ping()).resolves.toBe(false);
  });

  it('quits an open client during module destruction', async () => {
    const client = makeRedisClient();
    client.isOpen = true;
    client.isReady = true;
    createClientMock.mockReturnValue(client as never);
    const service = new RedisService({
      getOrThrow: vi.fn().mockReturnValue('redis://localhost:6379'),
    } as never);

    await Promise.all([service.onModuleDestroy(), service.onModuleDestroy()]);

    expect(client.quit).toHaveBeenCalledTimes(1);
  });

  it('does not block startup when Redis connection hangs', async () => {
    vi.useFakeTimers();
    try {
      const client = makeRedisClient();
      client.connect.mockReturnValue(new Promise(() => undefined));
      createClientMock.mockReturnValue(client as never);
      const service = new RedisService({
        getOrThrow: vi.fn().mockReturnValue('redis://localhost:6379'),
      } as never);

      const initialization = service.onModuleInit();
      let settled = false;
      void initialization.finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(settled).toBe(true);
      expect(client.destroy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not block shutdown when Redis quit hangs', async () => {
    vi.useFakeTimers();
    try {
      const client = makeRedisClient();
      client.isOpen = true;
      client.isReady = true;
      client.quit.mockReturnValue(new Promise(() => undefined));
      createClientMock.mockReturnValue(client as never);
      const service = new RedisService({
        getOrThrow: vi.fn().mockReturnValue('redis://localhost:6379'),
      } as never);

      const destruction = service.onModuleDestroy();
      let settled = false;
      void destruction.finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(settled).toBe(true);
      expect(client.destroy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

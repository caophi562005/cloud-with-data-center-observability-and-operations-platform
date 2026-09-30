import { Inject, Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service.js';

const REDIS_DELETE_BATCH_SIZE = 100;

interface RedisCacheClient {
  get?: (key: string) => Promise<string | null>;
  set?: (
    key: string,
    value: string,
    options: { EX: number },
  ) => Promise<unknown>;
  del?: (...keys: string[]) => Promise<unknown>;
  scanIterator?: (options?: { MATCH?: string }) => AsyncIterable<unknown>;
  scan?: (
    cursor: string,
    options?: { MATCH?: string },
  ) => Promise<{ cursor: string | number; keys: string[] }>;
}

type RedisDependency = RedisService | RedisCacheClient;

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(
    @Inject(RedisService)
    private readonly redisDependency: RedisDependency,
  ) {}

  async get<T>(key: string): Promise<T | null> {
    try {
      const client = this.getClient();
      if (!client.get) {
        return null;
      }

      const serialized = await client.get(key);
      return serialized === null ? null : (JSON.parse(serialized) as T);
    } catch {
      this.warn('read');
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      const client = this.getClient();
      if (!client.set || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
        return;
      }

      let serialized: string;
      try {
        serialized = JSON.stringify(value);
        if (serialized === undefined) {
          this.warn('write');
          return;
        }
      } catch {
        this.warn('write');
        return;
      }

      await client.set(key, serialized, { EX: ttlSeconds });
    } catch {
      this.warn('write');
    }
  }

  async delete(...keys: string[]): Promise<void> {
    try {
      const client = this.getClient();
      if (!client.del || keys.length === 0) {
        return;
      }

      await client.del(...keys);
    } catch {
      this.warn('delete');
    }
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    if (!prefix) {
      return;
    }

    try {
      const client = this.getClient();
      if (!client.scanIterator && !client.scan) {
        return;
      }

      const pattern = `${escapeRedisGlob(prefix)}*`;
      if (client.scanIterator) {
        for await (const page of client.scanIterator({ MATCH: pattern })) {
          await this.deleteInBatches(extractScanKeys(page));
        }
      } else if (client.scan) {
        let cursor = '0';
        do {
          const page = await client.scan(cursor, { MATCH: pattern });
          cursor = String(page.cursor);
          await this.deleteInBatches(page.keys);
        } while (cursor !== '0');
      }
    } catch {
      this.warn('prefix');
    }
  }

  private async deleteInBatches(keys: string[]): Promise<void> {
    for (
      let offset = 0;
      offset < keys.length;
      offset += REDIS_DELETE_BATCH_SIZE
    ) {
      await this.delete(
        ...keys.slice(offset, offset + REDIS_DELETE_BATCH_SIZE),
      );
    }
  }

  private getClient(): RedisCacheClient {
    const dependency = this.redisDependency as RedisService &
      Partial<RedisCacheClient>;

    if (typeof dependency.getClient === 'function') {
      return dependency.getClient() as unknown as RedisCacheClient;
    }

    return dependency;
  }

  private warn(operation: 'read' | 'write' | 'delete' | 'prefix'): void {
    this.logger.warn(`Redis cache ${operation} failed; continuing safely`);
  }
}

function escapeRedisGlob(value: string): string {
  let escaped = '';

  for (const character of value) {
    if ('*?[]\\'.includes(character)) {
      escaped += '\\';
    }
    escaped += character;
  }

  return escaped;
}

function extractScanKeys(page: unknown): string[] {
  if (Array.isArray(page)) {
    return page.filter((key): key is string => typeof key === 'string');
  }

  return typeof page === 'string' ? [page] : [];
}

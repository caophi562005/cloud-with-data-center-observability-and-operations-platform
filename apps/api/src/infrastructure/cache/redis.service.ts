import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type RedisClientType } from 'redis';

const REDIS_CONNECT_TIMEOUT_MS = 5_000;
const REDIS_QUIT_TIMEOUT_MS = 1_000;

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly client: RedisClientType;
  private connectPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly configService: ConfigService) {
    const url = this.configService.getOrThrow<string>('redis.url');
    this.client = createClient({
      url,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
        reconnectStrategy: false,
      },
    });

    // Redis emits connection errors asynchronously. Keep the cache dependency
    // optional without exposing connection details or credentials in logs.
    this.client.on('error', () => undefined);
  }

  getClient(): RedisClientType {
    return this.client;
  }

  async onModuleInit(): Promise<void> {
    if (this.client.isReady) {
      return;
    }

    if (!this.connectPromise) {
      this.connectPromise = this.connectWithFallback();
    }

    await this.connectPromise;
  }

  async ping(): Promise<boolean> {
    if (this.client.isReady === false) {
      return false;
    }

    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.closeWithFallback();
    }

    await this.closePromise;
  }

  private async connectWithFallback(): Promise<void> {
    try {
      await this.withTimeout(
        () => this.client.connect(),
        REDIS_CONNECT_TIMEOUT_MS,
      );
    } catch {
      this.destroyClient();
    }
  }

  private async closeWithFallback(): Promise<void> {
    if (this.connectPromise) {
      await this.connectPromise;
    }

    if (!this.client.isOpen && !this.client.isReady) {
      return;
    }

    try {
      await this.withTimeout(() => this.client.quit(), REDIS_QUIT_TIMEOUT_MS);
    } catch {
      this.destroyClient();
    }
  }

  private async withTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        operation(),
        new Promise<T>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Redis operation timed out')),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  private destroyClient(): void {
    try {
      this.client.destroy();
    } catch {
      // The cache dependency is best effort during startup and shutdown.
    }
  }
}

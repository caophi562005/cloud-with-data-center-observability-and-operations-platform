import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../infrastructure/database/prisma/prisma.service.js';
import { DatabaseHealthIndicator } from './database.health-indicator.js';

describe('DatabaseHealthIndicator', () => {
  it('reports an up status after a lightweight Prisma query', async () => {
    const prisma = { $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]) };
    const indicator = new DatabaseHealthIndicator(
      prisma as unknown as PrismaService,
    );

    await expect(indicator.isHealthy()).resolves.toEqual({
      database: { status: 'up' },
    });
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
  });

  it('reports only down status metadata when Prisma is unavailable', async () => {
    const prisma = {
      $queryRaw: vi.fn().mockRejectedValue(new Error('secret database detail')),
    };
    const indicator = new DatabaseHealthIndicator(
      prisma as unknown as PrismaService,
    );

    await expect(indicator.isHealthy()).resolves.toEqual({
      database: { status: 'down' },
    });
  });
});

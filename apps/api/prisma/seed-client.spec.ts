import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  PrismaClient: vi.fn(),
  PrismaPg: vi.fn(),
}));

vi.mock('@prisma/client', () => ({
  PrismaClient: mocks.PrismaClient,
}));
vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: mocks.PrismaPg,
}));

import { createSeedPrismaClient } from './seed-client.js';

describe('createSeedPrismaClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.PrismaPg.mockImplementation(function (
      this: { options: unknown },
      options: unknown,
    ) {
      this.options = options;
    });
    mocks.PrismaClient.mockImplementation(function (
      this: { options: unknown },
      options: unknown,
    ) {
      this.options = options;
    });
  });

  it('constructs PrismaClient with a PrismaPg driver adapter', () => {
    const connectionString = 'postgresql://seed-user:seed-pass@localhost/db';

    const client = createSeedPrismaClient(connectionString);
    const adapter = mocks.PrismaPg.mock.results[0]?.value;

    expect(mocks.PrismaPg).toHaveBeenCalledWith({ connectionString });
    expect(mocks.PrismaClient).toHaveBeenCalledWith({ adapter });
    expect(client).toBe(mocks.PrismaClient.mock.results[0]?.value);
  });
});

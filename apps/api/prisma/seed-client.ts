import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

export function createSeedPrismaClient(
  connectionString = process.env.DATABASE_URL,
): PrismaClient {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run the Prisma seed.');
  }

  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
}

import { PrismaClient, Role } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  try {
    await prisma.$connect();

    const organization = await prisma.organization.upsert({
      where: { slug: 'vnpt-cloud' },
      create: { name: 'VNPT Cloud', slug: 'vnpt-cloud' },
      update: { name: 'VNPT Cloud' },
    });

    const adminCognitoSub = process.env.SEED_ADMIN_COGNITO_SUB?.trim();
    if (!adminCognitoSub) {
      return;
    }

    const user = await prisma.user.findUnique({
      where: { cognitoSub: adminCognitoSub },
    });

    if (!user) {
      throw new Error(
        `Cannot assign ADMIN membership: no local user exists for SEED_ADMIN_COGNITO_SUB. Complete a Cognito login for "${adminCognitoSub}" to synchronize the user, then rerun the seed.`,
      );
    }

    await prisma.membership.upsert({
      where: {
        userId_organizationId: {
          userId: user.id,
          organizationId: organization.id,
        },
      },
      create: {
        userId: user.id,
        organizationId: organization.id,
        role: Role.ADMIN,
      },
      update: { role: Role.ADMIN },
    });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Prisma seed failed.');
  process.exitCode = 1;
});

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma/prisma.service.js';

export const USER_SELECT = {
  id: true,
  cognitoSub: true,
  email: true,
  displayName: true,
} as const satisfies Prisma.UserSelect;

export interface LocalUser {
  id: string;
  cognitoSub: string;
  email: string;
  displayName: string | null;
}

export interface CognitoUserInput {
  cognitoSub: string;
  email: string;
  displayName?: string;
}

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByCognitoSub(cognitoSub: string): Promise<LocalUser | null> {
    return this.prisma.user.findUnique({
      where: { cognitoSub },
      select: USER_SELECT,
    });
  }

  upsertFromCognito(input: CognitoUserInput): Promise<LocalUser> {
    const create: Prisma.UserCreateInput = {
      cognitoSub: input.cognitoSub,
      email: input.email,
    };
    const update: Prisma.UserUpdateInput = {
      email: input.email,
    };

    if (input.displayName !== undefined) {
      create.displayName = input.displayName;
      update.displayName = input.displayName;
    }

    return this.prisma.user.upsert({
      where: { cognitoSub: input.cognitoSub },
      create,
      update,
      select: USER_SELECT,
    });
  }
}

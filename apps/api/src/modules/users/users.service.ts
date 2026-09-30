import { Injectable } from '@nestjs/common';
import {
  ApplicationConflictError,
  hasPrismaErrorCode,
} from '../../common/errors/application-conflict.error.js';
import {
  CognitoUserInput,
  LocalUser,
  UsersRepository,
} from './users.repository.js';

@Injectable()
export class UsersService {
  constructor(private readonly usersRepository: UsersRepository) {}

  findByCognitoSub(cognitoSub: string): Promise<LocalUser | null> {
    return this.usersRepository.findByCognitoSub(cognitoSub);
  }

  async upsertFromCognito(input: CognitoUserInput): Promise<LocalUser> {
    try {
      return await this.usersRepository.upsertFromCognito(input);
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2002')) {
        throw new ApplicationConflictError(
          'USER_COGNITO_SUB_CONFLICT',
          'A local user already exists for this Cognito subject',
        );
      }
      throw error;
    }
  }
}

export type { CognitoUserInput, LocalUser } from './users.repository.js';

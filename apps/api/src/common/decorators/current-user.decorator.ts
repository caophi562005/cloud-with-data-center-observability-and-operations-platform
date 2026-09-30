import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from '../types/authenticated-user.type.js';
import type { RequestContext } from '../types/request-context.type.js';

type AuthenticatedUserKey = keyof AuthenticatedUser;

export const CurrentUser = createParamDecorator(
  (
    data: AuthenticatedUserKey | undefined,
    context: ExecutionContext,
  ):
    AuthenticatedUser | AuthenticatedUser[AuthenticatedUserKey] | undefined => {
    const request = context.switchToHttp().getRequest<RequestContext>();
    const user = request.user;

    if (!data) {
      return user;
    }

    return user?.[data];
  },
);

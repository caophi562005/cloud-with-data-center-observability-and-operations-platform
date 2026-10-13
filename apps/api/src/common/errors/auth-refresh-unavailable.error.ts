import { ServiceUnavailableException } from '@nestjs/common';

export function authRefreshUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'AUTH_REFRESH_UNAVAILABLE',
    message: 'We could not renew your session. Please try again.',
  });
}

import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { AuthService } from './auth.service.js';
import { CognitoAuthGuard } from './guards/cognito-auth.guard.js';
import { loginSchema, type LoginInput } from './schemas/login.schema.js';
import {
  confirmRegistrationSchema,
  registerSchema,
  resendConfirmationSchema,
  type ConfirmRegistrationInput,
  type RegisterInput,
  type ResendConfirmationInput,
} from './schemas/registration.schema.js';

@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('auth/login')
  login(
    @Body(new ZodValidationPipe(loginSchema)) input: LoginInput,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.authService.login(input, response);
  }

  @Public()
  @Post('auth/register')
  register(@Body(new ZodValidationPipe(registerSchema)) input: RegisterInput) {
    return this.authService.register({
      email: input.email,
      displayName: input.displayName,
      password: input.password,
    });
  }

  @Public()
  @Post('auth/register/confirm')
  confirmRegistration(
    @Body(new ZodValidationPipe(confirmRegistrationSchema))
    input: ConfirmRegistrationInput,
  ) {
    return this.authService.confirmRegistration(input);
  }

  @Public()
  @Post('auth/register/resend-code')
  resendConfirmationCode(
    @Body(new ZodValidationPipe(resendConfirmationSchema))
    input: ResendConfirmationInput,
  ) {
    return this.authService.resendRegistrationCode(input);
  }

  @Public()
  @Post('auth/refresh')
  refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.authService.refresh(request, response);
  }

  @Public()
  @Post('auth/logout')
  logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    return this.authService.logout(request, response);
  }

  @UseGuards(CognitoAuthGuard)
  @Get('me')
  me(@CurrentUser() principal: AuthenticatedUser) {
    return this.authService.getCurrentSession(principal);
  }
}

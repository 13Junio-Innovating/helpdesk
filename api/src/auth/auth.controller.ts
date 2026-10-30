import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';
import type { AuthResponse, MeResponse } from '@helpdesk/shared';
import type { Env } from '../config/env.js';
import type { AuthUser, TenantUser } from '../common/auth/auth-user.js';
import { AllowPreTenant, CurrentTenantUser, CurrentUser, Public, SensitiveAuth } from '../common/auth/decorators.js';
import { AuthService, type AuthResult } from './auth.service.js';
import { AcceptInviteDto, ForgotPasswordDto, LoginDto, ResetPasswordDto, SelectTenantDto, SignupDto } from './dto/auth.dto.js';

export const REFRESH_COOKIE = 'hd_rt';
/** O cookie só viaja para as rotas de auth (refresh/logout), nunca para o resto da API. */
const COOKIE_PATH = '/api/v1/auth';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly cookie: CookieOptions;

  constructor(
    private readonly auth: AuthService,
    config: ConfigService<Env, true>,
  ) {
    this.cookie = {
      httpOnly: true,
      secure: config.get('COOKIE_SECURE', { infer: true }),
      sameSite: 'lax',
      path: COOKIE_PATH,
      maxAge: config.get('REFRESH_TTL_DAYS', { infer: true }) * 86_400_000,
    };
  }

  @Public()
  @SensitiveAuth()
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response): Promise<AuthResponse> {
    return this.respond(res, await this.auth.login(dto));
  }

  @AllowPreTenant()
  @ApiBearerAuth()
  @Post('select-tenant')
  @HttpCode(200)
  async selectTenant(
    @CurrentUser() user: AuthUser,
    @Body() dto: SelectTenantDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    return this.respond(res, await this.auth.selectTenant(user.userId, dto.tenantId));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<AuthResponse> {
    try {
      return this.respond(res, await this.auth.refresh(this.readCookie(req)));
    } catch (e) {
      res.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
      throw e;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(this.readCookie(req));
    res.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentTenantUser() user: TenantUser): Promise<MeResponse> {
    return this.auth.me(user);
  }

  @Public()
  @SensitiveAuth()
  @Post('signup')
  async signup(@Body() dto: SignupDto, @Res({ passthrough: true }) res: Response): Promise<AuthResponse> {
    return this.respond(res, await this.auth.signup(dto));
  }

  @Public()
  @SensitiveAuth()
  @Post('accept-invite')
  @HttpCode(200)
  async acceptInvite(@Body() dto: AcceptInviteDto, @Res({ passthrough: true }) res: Response): Promise<AuthResponse> {
    return this.respond(res, await this.auth.acceptInvite(dto));
  }

  @Public()
  @SensitiveAuth()
  @Post('forgot-password')
  @HttpCode(202)
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<{ message: string }> {
    await this.auth.forgotPassword(dto);
    return { message: 'Se o e-mail estiver cadastrado, enviaremos um link para redefinir a senha.' };
  }

  @Public()
  @SensitiveAuth()
  @Post('reset-password')
  @HttpCode(204)
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.auth.resetPassword(dto);
  }

  private respond(res: Response, result: AuthResult): AuthResponse {
    if (result.refreshToken) res.cookie(REFRESH_COOKIE, result.refreshToken, this.cookie);
    return result.body;
  }

  private readCookie(req: Request): string | undefined {
    const value: unknown = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}

import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';
import type { TenantAuth, UserAuth } from '../common/auth/auth.types.js';
import { AllowPreTenant, AuthRateLimit, CurrentAuth, CurrentUser, Public } from '../common/auth/decorators.js';
import { AppError } from '../common/errors/app-error.js';
import { AppConfig } from '../config/app-config.js';
import { AuthService } from './auth.service.js';
import { LoginDto, SelectTenantDto, SignupDto } from './dto/auth.dto.js';

export const REFRESH_COOKIE = 'sd_rt';
const COOKIE_PATH = '/api/v1/auth';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfig,
  ) {}

  @Public()
  @AuthRateLimit()
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.login(dto);
    if (r.session) {
      this.setRefreshCookie(res, r.session.refreshToken);
      return {
        user: r.user,
        workspaces: r.workspaces,
        tenantId: r.session.tenantId,
        accessToken: r.session.accessToken,
        expiresIn: r.session.expiresIn,
        needsTenantSelection: false,
      };
    }
    return {
      user: r.user,
      workspaces: r.workspaces,
      preTenantToken: r.preTenantToken!.token,
      expiresIn: r.preTenantToken!.expiresIn,
      needsTenantSelection: true,
    };
  }

  @AllowPreTenant()
  @ApiBearerAuth()
  @Get('workspaces')
  workspaces(@CurrentUser() user: UserAuth) {
    return this.auth.listWorkspacesFor(user.userId);
  }

  @AllowPreTenant()
  @ApiBearerAuth()
  @Post('select-tenant')
  @HttpCode(200)
  async selectTenant(
    @CurrentUser() user: UserAuth,
    @Body() dto: SelectTenantDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const s = await this.auth.selectTenant(user.userId, dto.tenantId, this.readRefreshCookie(req));
    this.setRefreshCookie(res, s.refreshToken);
    return { tenantId: dto.tenantId, accessToken: s.accessToken, expiresIn: s.expiresIn };
  }

  @Public()
  @AuthRateLimit()
  @Post('signup')
  async signup(@Body() dto: SignupDto, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.signup(dto);
    this.setRefreshCookie(res, r.session.refreshToken);
    return { userId: r.userId, tenantId: r.tenantId, accessToken: r.session.accessToken, expiresIn: r.session.expiresIn };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = this.readRefreshCookie(req);
    if (!token) throw new AppError(401, 'refresh_missing', 'Sessão expirada. Entre novamente.');
    try {
      const s = await this.auth.refresh(token);
      this.setRefreshCookie(res, s.refreshToken);
      return { tenantId: s.tenantId, accessToken: s.accessToken, expiresIn: s.expiresIn };
    } catch (err) {
      if (err instanceof AppError && err.getStatus() === 401) this.clearRefreshCookie(res);
      throw err;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = this.readRefreshCookie(req);
    if (token) await this.auth.logout(token);
    this.clearRefreshCookie(res);
  }

  @AllowPreTenant()
  @ApiBearerAuth()
  @Post('logout-all')
  @HttpCode(200)
  async logoutAll(@CurrentUser() user: UserAuth, @Res({ passthrough: true }) res: Response) {
    const revoked = await this.auth.logoutAll(user.userId);
    this.clearRefreshCookie(res);
    return { revokedSessions: revoked };
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentAuth() auth: TenantAuth) {
    return this.auth.me(auth);
  }

  private cookieOptions(): CookieOptions {
    return { httpOnly: true, secure: this.config.get('COOKIE_SECURE'), sameSite: 'lax', path: COOKIE_PATH };
  }

  private setRefreshCookie(res: Response, token: string): void {
    res.cookie(REFRESH_COOKIE, token, { ...this.cookieOptions(), maxAge: this.config.get('REFRESH_TTL_DAYS') * 86_400_000 });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  private readRefreshCookie(req: Request): string | undefined {
    const v: unknown = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
    return typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : undefined;
  }
}

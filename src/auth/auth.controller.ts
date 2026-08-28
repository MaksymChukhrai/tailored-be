import {
  Controller,
  Get,
  Logger,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import type { AppConfig } from '../config/configuration';
import { AuthService, TokenPair } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import type { GoogleProfile } from './strategies/google.strategy';
import type { JwtPayload } from './strategies/jwt-access.strategy';
import type { JwtRefreshPayload } from './strategies/jwt-refresh.strategy';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  public constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  @Public()
  @Get('google')
  @UseGuards(AuthGuard('google'))
  public googleLogin(): void {
    // Passport redirects to Google's consent screen; handler body is unused.
  }

  @Public()
  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  public async googleCallback(
    @Req() req: Request & { user: GoogleProfile },
    @Res() res: Response,
  ): Promise<void> {
    try {
      const tokens = await this.authService.loginWithGoogle(req.user);
      this.setAuthCookies(res, tokens);
      const frontendUrl = this.configService.get('frontendUrl', { infer: true });
      res.redirect(`${frontendUrl}/auth/callback`);
    } catch (error: unknown) {
      this.logger.error('Google callback failed', error);
      const frontendUrl = this.configService.get('frontendUrl', { infer: true });
      res.redirect(`${frontendUrl}/auth/error`);
    }
  }

  @Public()
  @Post('refresh')
  @UseGuards(AuthGuard('jwt-refresh'))
  public async refresh(
    @CurrentUser() user: JwtRefreshPayload,
    @Res() res: Response,
  ): Promise<void> {
    const tokens = await this.authService.refresh(user);
    this.setAuthCookies(res, tokens);
    res.status(200).send({ success: true });
  }

  @Post('logout')
  @UseGuards(AuthGuard('jwt-access'))
  public async logout(
    @Req() req: Request,
    @CurrentUser() user: JwtPayload,
    @Res() res: Response,
  ): Promise<void> {
    const cookies = req.cookies as Record<string, string | undefined>;
    const refreshToken = cookies.refresh_token;
    if (refreshToken) {
      await this.authService.logout(user.sub, refreshToken);
    }
    this.clearAuthCookies(res);
    res.status(200).send({ success: true });
  }

  @Get('me')
  @UseGuards(AuthGuard('jwt-access'))
  public getMe(@CurrentUser() user: JwtPayload): JwtPayload {
    return user;
  }

  private setAuthCookies(res: Response, tokens: TokenPair): void {
    const isProduction = this.configService.get('nodeEnv', { infer: true }) === 'production';

    res.cookie('access_token', tokens.accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: tokens.accessExpiresInMs,
      path: '/',
    });

    res.cookie('refresh_token', tokens.refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: tokens.refreshExpiresInMs,
      path: '/',
    });
  }

  private clearAuthCookies(res: Response): void {
    res.clearCookie('access_token', { path: '/' });
    res.clearCookie('refresh_token', { path: '/' });
  }
}

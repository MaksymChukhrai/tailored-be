import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AppConfig } from '../../config/configuration';
import type { JwtPayload } from './jwt-access.strategy';

function extractFromCookie(req: Request): string | null {
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  return cookies?.refresh_token ?? null;
}

export interface JwtRefreshPayload extends JwtPayload {
  refreshToken: string;
}

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {
  public constructor(configService: ConfigService<AppConfig, true>) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([extractFromCookie]),
      ignoreExpiration: false,
      secretOrKey: configService.get('jwt', { infer: true }).refreshSecret,
      passReqToCallback: true,
    });
  }

  public validate(req: Request, payload: JwtPayload): JwtRefreshPayload {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const refreshToken = cookies?.refresh_token;
    if (!refreshToken) {
      throw new Error('Refresh token missing from request');
    }
    return { ...payload, refreshToken };
  }
}

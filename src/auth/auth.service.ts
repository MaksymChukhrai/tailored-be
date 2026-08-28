import { createHash } from "node:crypto";
import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import type { AppConfig } from "../config/configuration";
import { PrismaService } from "../prisma/prisma.service";
import { UsersService } from "../users/users.service";
import type { GoogleProfile } from "./strategies/google.strategy";
import type { JwtPayload } from "./strategies/jwt-access.strategy";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresInMs: number;
  refreshExpiresInMs: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  public constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  public async loginWithGoogle(profile: GoogleProfile): Promise<TokenPair> {
    try {
      const user = await this.usersService.upsertFromGoogle(profile);
      return await this.issueTokenPair(user.id, user.email);
    } catch (error: unknown) {
      this.logger.error("Google login failed", error);
      throw error;
    }
  }

  public async refresh(payload: {
    sub: string;
    email: string;
    refreshToken: string;
  }): Promise<TokenPair> {
    const tokenHash = this.hashToken(payload.refreshToken);

    const storedToken = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (
      !storedToken ||
      storedToken.revokedAt ||
      storedToken.expiresAt < new Date()
    ) {
      throw new UnauthorizedException("Refresh token is invalid or expired");
    }

    // Rotation: revoke the used token and issue a brand new pair,
    // so a stolen refresh token can only be replayed once before
    // the legitimate owner's next refresh invalidates it.
    await this.prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokenPair(payload.sub, payload.email);
  }

  public async logout(userId: string, refreshToken: string): Promise<void> {
    const tokenHash = this.hashToken(refreshToken);
    try {
      await this.prisma.refreshToken.updateMany({
        where: { userId, tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } catch (error: unknown) {
      this.logger.error(
        `Failed to revoke refresh token for user ${userId}`,
        error,
      );
      throw error;
    }
  }

  public async logoutAll(userId: string): Promise<void> {
    try {
      await this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } catch (error: unknown) {
      this.logger.error(
        `Failed to revoke all refresh tokens for user ${userId}`,
        error,
      );
      throw error;
    }
  }

  private async issueTokenPair(
    userId: string,
    email: string,
  ): Promise<TokenPair> {
    const jwtConfig = this.configService.get("jwt", { infer: true });
    const payload: JwtPayload = { sub: userId, email };

    const accessToken = this.jwtService.sign(payload, {
      secret: jwtConfig.accessSecret,
      expiresIn: jwtConfig.accessExpiresIn,
    });

    // The refresh cookie carries a signed JWT (so JwtRefreshStrategy can
    // verify expiry/signature statelessly), while its hash is stored so
    // it can be looked up and revoked server-side.
    const finalRefreshToken = this.jwtService.sign(payload, {
      secret: jwtConfig.refreshSecret,
      expiresIn: jwtConfig.refreshExpiresIn,
    });

    const refreshExpiresInMs = this.parseDurationToMs(
      jwtConfig.refreshExpiresIn,
    );
    const accessExpiresInMs = this.parseDurationToMs(jwtConfig.accessExpiresIn);

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hashToken(finalRefreshToken),
        expiresAt: new Date(Date.now() + refreshExpiresInMs),
      },
    });

    return {
      accessToken,
      refreshToken: finalRefreshToken,
      accessExpiresInMs,
      refreshExpiresInMs,
    };
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private parseDurationToMs(duration: string): number {
    const match = /^(\d+)([smhd])$/.exec(duration);
    if (!match) {
      return 15 * 60 * 1000;
    }
    const value = Number(match[1]);
    const unit = match[2];
    const unitMs: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };
    return value * (unitMs[unit] ?? 60 * 1000);
  }
}

import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { JwtPayload } from '../strategies/jwt-access.strategy';

/**
 * Used on endpoints reachable via a public share link, where the viewer
 * may or may not be logged in. Never throws on a missing/invalid token —
 * it simply leaves `request.user` undefined so the controller can branch
 * on public-link vs permissioned-share logic itself.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt-access') {
  public handleRequest<TUser = JwtPayload>(
    _err: unknown,
    user: TUser | false,
  ): TUser | undefined {
    return user === false ? undefined : user;
  }

  public canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    return super.canActivate(context) as boolean | Promise<boolean>;
  }
}

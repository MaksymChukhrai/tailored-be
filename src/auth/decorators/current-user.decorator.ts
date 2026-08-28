import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import type { JwtPayload } from '../strategies/jwt-access.strategy';

/**
 * Extracts the authenticated user's JWT payload from the request.
 * Returns undefined on routes guarded by OptionalJwtAuthGuard when
 * no valid token was present.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload | undefined => {
    const request = ctx.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    return request.user;
  },
);

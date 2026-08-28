import { Injectable, Logger } from '@nestjs/common';
import { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { GoogleProfile } from '../auth/strategies/google.strategy';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  public constructor(private readonly prisma: PrismaService) {}

  public async upsertFromGoogle(profile: GoogleProfile): Promise<User> {
    try {
      return await this.prisma.user.upsert({
        where: { googleId: profile.googleId },
        create: {
          googleId: profile.googleId,
          email: profile.email,
          name: profile.name,
          avatarUrl: profile.avatarUrl,
        },
        update: {
          email: profile.email,
          name: profile.name,
          avatarUrl: profile.avatarUrl,
        },
      });
    } catch (error: unknown) {
      this.logger.error(`Failed to upsert user for Google id ${profile.googleId}`, error);
      throw error;
    }
  }

  public async findById(id: string): Promise<User | null> {
    try {
      return await this.prisma.user.findUnique({ where: { id } });
    } catch (error: unknown) {
      this.logger.error(`Failed to find user ${id}`, error);
      throw error;
    }
  }

  public async findByEmail(email: string): Promise<User | null> {
    try {
      return await this.prisma.user.findUnique({ where: { email } });
    } catch (error: unknown) {
      this.logger.error(`Failed to find user by email ${email}`, error);
      throw error;
    }
  }
}

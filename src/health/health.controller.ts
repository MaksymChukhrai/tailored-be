import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';

@Controller()
export class HealthController {
  @Public()
  @Get()
  public check(): { status: string } {
    return { status: 'ok' };
  }
}

import { Controller, Get } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

@ApiTags('health')
@Controller()
export class AppController {
  @Get()
  @ApiOperation({ summary: 'Health check' })
  @ApiResponse({ status: 200, description: 'API is healthy' })
  getHealth() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'Kira Studio Backend',
      version: '1.0.0' };
  }

  @Get('ping')
  @ApiOperation({ summary: 'Simple ping' })
  ping() {
    return 'pong';
  }
}
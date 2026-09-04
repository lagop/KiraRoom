import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WaitListService, WaitListCreateDto, WaitListUpdateDto } from './wait-list.service';

@Controller('wait-list')
@UseGuards(JwtAuthGuard)
export class WaitListController {
  constructor(private readonly svc: WaitListService) {}

  @Get()
  list(
    @Query('tenantId') tenantId: string,
    @Query('status') status?: string,
    @Query('serviceId') serviceId?: string,
  ) {
    return this.svc.list(tenantId, {
      status: status as any,
      serviceId,
    });
  }

  @Post()
  add(@Body('tenantId') tenantId: string, @Body() dto: WaitListCreateDto) {
    return this.svc.add(tenantId, dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: WaitListUpdateDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
}

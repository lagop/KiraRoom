import { ParseUUIDPipe, Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WaitListService, WaitListCreateDto, WaitListUpdateDto } from './wait-list.service';
import { Roles, SALON_TEAM } from "../auth/decorators/roles.decorator";

@Controller('wait-list')
@UseGuards(JwtAuthGuard)
export class WaitListController {
  constructor(private readonly svc: WaitListService) {}

  @Get()
  @Roles(...SALON_TEAM)
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
  @Roles(...SALON_TEAM)
  add(@Body('tenantId') tenantId: string, @Body() dto: WaitListCreateDto) {
    return this.svc.add(tenantId, dto);
  }

  @Patch(':id')
  @Roles(...SALON_TEAM)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: WaitListUpdateDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @Roles(...SALON_TEAM)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(id);
  }
}

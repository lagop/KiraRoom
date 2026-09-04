import { ParseUUIDPipe, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { FeatureGuard } from "../common/guards/feature.guard";
import { Feature } from "../common/decorators/feature.decorator";
import { GiftCardsService } from "./gift-cards.service";
import { CreateGiftCardDto } from "./dto/create-gift-card.dto";
import { RedeemGiftCardDto } from "./dto/redeem-gift-card.dto";
import { UpdateGiftCardDto } from "./dto/update-gift-card.dto";

@ApiTags("gift-cards")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@Controller("gift-cards")
export class GiftCardsController {
  constructor(private readonly service: GiftCardsService) {}

  @Get()
  @Roles("owner", "admin", "staff")
  findAll(
    @Req() req: any,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("isActive") isActive?: string,
  ) {
    return this.service.findAll(req.user.tenantId, {
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
      isActive:
        isActive === undefined ? undefined : isActive === "true" || isActive === "1",
    });
  }

  @Get("lookup/:code")
  @Roles("owner", "admin", "staff")
  lookup(@Req() req: any, @Param("code") code: string) {
    return this.service.lookupByCode(req.user.tenantId, code);
  }

  @Get(":id")
  @Roles("owner", "admin", "staff")
  findOne(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.service.findOne(req.user.tenantId, id);
  }

  @Post()
  @Roles("owner", "admin")
  @Feature("gift_cards")
  create(@Req() req: any, @Body() dto: CreateGiftCardDto) {
    return this.service.create(req.user.tenantId, dto);
  }

  @Patch(":id")
  @Roles("owner", "admin")
  @Feature("gift_cards")
  update(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateGiftCardDto,
  ) {
    return this.service.update(req.user.tenantId, id, dto);
  }

  @Post("redeem")
  @Roles("owner", "admin", "staff")
  @Feature("gift_cards")
  redeem(@Req() req: any, @Body() dto: RedeemGiftCardDto) {
    return this.service.redeem(req.user.tenantId, dto);
  }

  @Delete(":id")
  @Roles("owner", "admin")
  @Feature("gift_cards")
  remove(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.service.remove(req.user.tenantId, id);
  }
}

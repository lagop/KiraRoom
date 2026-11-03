import { ParseUUIDPipe, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles, SALON_MANAGERS, SALON_TEAM } from "../auth/decorators/roles.decorator";
import { FeatureGuard } from "../common/guards/feature.guard";
import { Feature } from "../common/decorators/feature.decorator";
import { GiftCardsService } from "./gift-cards.service";
import { CreateGiftCardDto } from "./dto/create-gift-card.dto";
import { ListGiftCardsQueryDto } from "./dto/list-gift-cards-query.dto";
import { RedeemGiftCardDto } from "./dto/redeem-gift-card.dto";
import { UpdateGiftCardDto } from "./dto/update-gift-card.dto";

/**
 * Who does what:
 * - Looking a card up by its code is a till action: the whole team (staff
 *   included), whatever the plan. The till spends the card inside the sale
 *   (a gift-card tender), so a client who paid for a card can still spend
 *   it after the salon downgrades.
 * - Redeeming a card on its own, outside a sale, is the Tarjetas regalo
 *   screen: managers, on a plan with gift cards. For staff it lowered the
 *   balance with no sale behind it, off the takings and the till count.
 * - Listing every card, the detail with its movements, issuing, editing and
 *   deactivating are for managers (as the menu), and need the plan feature
 *   (as the menu).
 */
@ApiTags("gift-cards")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@Controller("gift-cards")
export class GiftCardsController {
  constructor(private readonly service: GiftCardsService) {}

  @Get()
  @Roles(...SALON_MANAGERS)
  @Feature("gift_cards")
  findAll(@Req() req: any, @Query() query: ListGiftCardsQueryDto) {
    return this.service.findAll(req.user.tenantId, {
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      isActive: query.isActive,
    });
  }

  @Get("lookup/:code")
  @Roles(...SALON_TEAM)
  lookup(@Req() req: any, @Param("code") code: string) {
    return this.service.lookupByCode(req.user.tenantId, code);
  }

  @Get(":id")
  @Roles(...SALON_MANAGERS)
  @Feature("gift_cards")
  findOne(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.service.findOne(req.user.tenantId, id);
  }

  @Post()
  @Roles(...SALON_MANAGERS)
  @Feature("gift_cards")
  create(@Req() req: any, @Body() dto: CreateGiftCardDto) {
    return this.service.create(req.user.tenantId, dto, req.user.id);
  }

  @Patch(":id")
  @Roles(...SALON_MANAGERS)
  @Feature("gift_cards")
  update(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateGiftCardDto,
  ) {
    return this.service.update(req.user.tenantId, id, dto);
  }

  @Post("redeem")
  @Roles(...SALON_MANAGERS)
  @Feature("gift_cards")
  redeem(@Req() req: any, @Body() dto: RedeemGiftCardDto) {
    return this.service.redeem(req.user.tenantId, dto, req.user.id);
  }

  @Delete(":id")
  @Roles(...SALON_MANAGERS)
  @Feature("gift_cards")
  remove(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.service.remove(req.user.tenantId, id);
  }
}

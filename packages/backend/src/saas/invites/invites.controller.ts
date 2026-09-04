import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { InviteStatus } from "@prisma/client";
import { Public } from "../../auth/decorators/public.decorator";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { SaasOwnerGuard } from "../guards/saas-owner.guard";
import { SaasOwner } from "../decorators/saas-owner.decorator";
import { AcceptInviteDto } from "./dto/accept-invite.dto";
import { CreateInviteDto } from "./dto/create-invite.dto";
import { InvitesService, type InviteAcceptanceContext, type InviteView } from "./invites.service";

/**
 * Public endpoints for the invite-acceptance wizard at
 * `/accept-invite/[token]`. Marked `@Public()` so they bypass the
 * global JwtAuthGuard.
 */
@ApiTags("Tenant Invites (public)")
@Controller("invites")
export class PublicInvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Public()
  @Get(":token")
  @ApiOperation({
    summary: "Resolve a tenant-invite token (public; no auth required)",
  })
  @ApiResponse({ status: 200, description: "Invite is valid" })
  @ApiResponse({ status: 404, description: "Invite not found / expired / used" })
  async getInvite(@Param("token") token: string): Promise<InviteAcceptanceContext> {
    return this.invites.getInviteForAcceptance(token);
  }

  @Public()
  @Post(":token/accept")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Accept an invite — creates the tenant + first owner user",
  })
  @ApiResponse({ status: 200, description: "Tokens issued for instant dashboard access" })
  @ApiResponse({ status: 403, description: "Invite is expired, revoked, or already used" })
  async acceptInvite(
    @Param("token") token: string,
    @Body() dto: AcceptInviteDto,
  ) {
    return this.invites.acceptInvite(token, dto);
  }
}

/**
 * SaaS-admin endpoints for minting, listing, revoking, and resending
 * tenant invites. Mirrors the guard stack on `SaasController`.
 */
@ApiTags("SaaS Tenant Invites")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SaasOwnerGuard)
@SaasOwner()
@Controller("saas/invites")
export class SaasInvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Mint a new tenant invite (SaaS Owner only)" })
  @ApiResponse({ status: 201, description: "Invite created; magic link returned once" })
  @ApiResponse({ status: 409, description: "Active invite already exists for this email + tenant" })
  async create(
    @Req() req: any,
    @Body() dto: CreateInviteDto,
  ): Promise<InviteView> {
    return this.invites.createInvite(dto, req.user.id);
  }

  @Get()
  @ApiOperation({ summary: "List tenant invites (SaaS Owner only)" })
  @ApiResponse({ status: 200, description: "Invite list (newest first)" })
  async list(
    @Query("status") status?: InviteStatus,
    @Query("email") email?: string,
  ): Promise<InviteView[]> {
    return this.invites.listInvites({ status, email });
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Revoke a pending invite (SaaS Owner only)" })
  @ApiResponse({ status: 200, description: "Invite revoked" })
  @ApiResponse({ status: 400, description: "Invite is not in a revocable state" })
  async revoke(@Req() req: any, @Param("id") id: string): Promise<InviteView> {
    return this.invites.revokeInvite(id, req.user.id);
  }

  @Post(":id/resend")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Resend a pending invite with a fresh token + link" })
  @ApiResponse({ status: 200, description: "Fresh invite created; old one revoked" })
  async resend(@Req() req: any, @Param("id") id: string): Promise<InviteView> {
    return this.invites.resendInvite(id, req.user.id);
  }
}
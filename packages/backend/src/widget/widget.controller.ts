import { ParseUUIDPipe, Controller, Get, Post, Patch, Delete, Body, Param, Req, Res, UseGuards, BadRequestException } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { Public } from "../auth/decorators/public.decorator";
import { WidgetService } from "./widget.service";
import { CreateWidgetDto, MAX_WIDGET_THEME_BYTES, UpdateWidgetDto } from "./widget.dto";
import { Roles, SALON_MANAGERS } from "../auth/decorators/roles.decorator";

interface AuthedRequest extends Request {
  user: { id: string; tenantId: string; role: string };
}

function assertThemeSize(theme: unknown): void {
  if (theme && JSON.stringify(theme).length > MAX_WIDGET_THEME_BYTES) {
    throw new BadRequestException("theme too large");
  }
}

@ApiTags("widget")
@Controller("widget")
export class WidgetController {
  constructor(private readonly widgetService: WidgetService) {}

  @Get("instances")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List widget instances for current tenant" })
  @Roles(...SALON_MANAGERS)
  async list(@Req() req: AuthedRequest) {
    return this.widgetService.list(req.user.tenantId);
  }

  @Post("instances")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Create a widget instance (token returned once)" })
  @Roles(...SALON_MANAGERS)
  async create(@Req() req: AuthedRequest, @Body() body: CreateWidgetDto) {
    if (!body?.name) throw new BadRequestException("name is required");
    assertThemeSize(body.theme);
    const created = await this.widgetService.create(req.user.tenantId, body);
    return {
      id: created.id,
      token: created.token,
      name: created.name,
      allowedOrigins: created.allowedOrigins,
      services: created.services,
      professionals: created.professionals,
      theme: created.theme,
      createdAt: created.createdAt,
    };
  }

  @Patch("instances/:id")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update whitelist / theme for a widget instance" })
  @Roles(...SALON_MANAGERS)
  async update(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: UpdateWidgetDto,
  ) {
    assertThemeSize(body.theme);
    return this.widgetService.update(req.user.tenantId, id, body);
  }

  @Delete("instances/:id")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Revoke a widget instance" })
  @Roles(...SALON_MANAGERS)
  async revoke(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.widgetService.revoke(req.user.tenantId, id);
  }
}

@ApiTags("widget-public")
@Controller("embed")
export class EmbedController {
  constructor(private readonly widgetService: WidgetService) {}

  @Get(":token")
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @ApiOperation({ summary: "Public widget config by token" })
  async getConfig(@Param("token") token: string, @Res() res: Response) {
    const widget = await this.widgetService.findByToken(token);
    const data = await this.widgetService.getPublicConfig(widget.id);
    // Which sites may frame the widget is said by the embed PAGE
    // (frontend middleware, from frameAncestors below): a frame-ancestors
    // header on this JSON restricted nothing.
    res.setHeader("Cache-Control", "public, max-age=30");
    return res.json(data);
  }

  /**
   * The allowed origins, for the frontend's embed page header. Asked by
   * the Next server (cached there for a minute), so the limit is high.
   */
  @Get(":token/frame-ancestors")
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 600 } })
  @ApiOperation({ summary: "Sites allowed to frame the widget (public)" })
  async frameAncestors(@Param("token") token: string) {
    return this.widgetService.frameAncestors(token);
  }
}
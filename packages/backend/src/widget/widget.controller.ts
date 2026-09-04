import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  Res,
  Headers,
  UseGuards,
  BadRequestException,
} from "@nestjs/common";
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

interface AuthedRequest extends Request {
  user: { id: string; tenantId: string; role: string };
}

class CreateWidgetDto {
  name: string;
  allowedOrigins?: string[];
  services?: string[];
  professionals?: string[];
  theme?: Record<string, unknown>;
}

class UpdateWidgetDto {
  name?: string;
  allowedOrigins?: string[];
  services?: string[];
  professionals?: string[];
  theme?: Record<string, unknown>;
}

@ApiTags("widget")
@Controller("widget")
export class WidgetController {
  constructor(private readonly widgetService: WidgetService) {}

  @Get("instances")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List widget instances for current tenant" })
  async list(@Req() req: AuthedRequest) {
    return this.widgetService.list(req.user.tenantId);
  }

  @Post("instances")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Create a widget instance (token returned once)" })
  async create(@Req() req: AuthedRequest, @Body() body: CreateWidgetDto) {
    if (!body?.name) throw new BadRequestException("name is required");
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
  async update(
    @Req() req: AuthedRequest,
    @Param("id") id: string,
    @Body() body: UpdateWidgetDto,
  ) {
    return this.widgetService.update(req.user.tenantId, id, body);
  }

  @Delete("instances/:id")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Revoke a widget instance" })
  async revoke(@Req() req: AuthedRequest, @Param("id") id: string) {
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
    const allowedOrigins = (widget.allowedOrigins ?? []) as string[];
    const ancestors =
      allowedOrigins.length > 0 ? allowedOrigins.join(" ") : "*";
    res.setHeader(
      "Content-Security-Policy",
      `frame-ancestors ${ancestors}`,
    );
    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.setHeader("Cache-Control", "public, max-age=30");
    return res.json(data);
  }
}
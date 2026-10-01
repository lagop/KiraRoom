import { Controller, Post, Get, Body, Req, UseGuards, Res, BadRequestException } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { ImportService } from "./import.service";
import { Roles, SALON_MANAGERS } from "../auth/decorators/roles.decorator";
import { IsOptional, IsString, MaxLength } from "class-validator";

interface AuthedRequest extends Request {
  user: { id: string; tenantId: string; role: string };
}

/**
 * The global ValidationPipe runs with whitelist: true, which strips every
 * property without a validation decorator. This class had none, so "csv"
 * never reached the handler and every import answered "csv body required".
 */
class CsvBody {
  @IsString()
  @MaxLength(5_000_000)
  csv!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  filename?: string;
}

@ApiTags("import")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("import")
export class ImportController {
  constructor(private readonly importService: ImportService) {}

  @Post("clients/dry-run")
  @ApiTags("import")
  @Roles(...SALON_MANAGERS)
  async dryRun(@Req() req: AuthedRequest, @Body() body: CsvBody) {
    if (!body?.csv) throw new BadRequestException("csv body required");
    return this.importService.dryRunClients(
      req.user.tenantId,
      body.csv,
      body.filename || "upload.csv",
    );
  }

  @Post("clients/commit")
  @Roles(...SALON_MANAGERS)
  async commit(@Req() req: AuthedRequest, @Body() body: CsvBody) {
    if (!body?.csv) throw new BadRequestException("csv body required");
    return this.importService.commitClients(
      req.user.tenantId,
      body.csv,
      body.filename || "upload.csv",
    );
  }

  @Post("services/dry-run")
  @Roles(...SALON_MANAGERS)
  async dryRunServices(@Req() req: AuthedRequest, @Body() body: CsvBody) {
    return this.importService.dryRunServices(req.user.tenantId, body.csv, body.filename || "upload.csv");
  }

  @Post("services/commit")
  @Roles(...SALON_MANAGERS)
  async commitServices(@Req() req: AuthedRequest, @Body() body: CsvBody) {
    return this.importService.commitServices(req.user.tenantId, body.csv, body.filename || "upload.csv");
  }

  @Get("jobs")
  @Roles(...SALON_MANAGERS)
  async jobs(@Req() req: AuthedRequest) {
    return this.importService.listJobs(req.user.tenantId);
  }

  @Get("template/clients")
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Roles(...SALON_MANAGERS)
  async templateClients(@Res() res: Response) {
    const csv = this.importService.getClientTemplate();
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=clients-template.csv",
    );
    return res.send(csv);
  }

  @Get("template/services")
  @Roles(...SALON_MANAGERS)
  async templateServices(@Res() res: Response) {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=servicios-plantilla.csv");
    return res.send(this.importService.getServiceTemplate());
  }
}
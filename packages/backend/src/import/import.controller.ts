import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  UseGuards,
  Res,
  BadRequestException,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { ImportService } from "./import.service";

interface AuthedRequest extends Request {
  user: { id: string; tenantId: string; role: string };
}

class CsvBody {
  csv: string;
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
  async dryRun(@Req() req: AuthedRequest, @Body() body: CsvBody) {
    if (!body?.csv) throw new BadRequestException("csv body required");
    return this.importService.dryRunClients(
      req.user.tenantId,
      body.csv,
      body.filename || "upload.csv",
    );
  }

  @Post("clients/commit")
  async commit(@Req() req: AuthedRequest, @Body() body: CsvBody) {
    if (!body?.csv) throw new BadRequestException("csv body required");
    return this.importService.commitClients(
      req.user.tenantId,
      body.csv,
      body.filename || "upload.csv",
    );
  }

  @Get("jobs")
  async jobs(@Req() req: AuthedRequest) {
    return this.importService.listJobs(req.user.tenantId);
  }

  @Get("template/clients")
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  async templateClients(@Res() res: Response) {
    const csv = this.importService.getClientTemplate();
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=clients-template.csv",
    );
    return res.send(csv);
  }
}
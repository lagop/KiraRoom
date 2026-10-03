import { Controller, Post, Get, Body, Req, UseGuards, Res, BadRequestException } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { ImportFile, ImportService } from "./import.service";
import { Roles, SALON_MANAGERS } from "../auth/decorators/roles.decorator";
import { IsBase64, IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";

interface AuthedRequest extends Request {
  user: { id: string; tenantId: string; role: string };
}

/**
 * The global ValidationPipe runs with whitelist: true, which strips every
 * property without a validation decorator. This class had none, so "csv"
 * never reached the handler and every import answered "csv body required".
 *
 * The file comes as CSV text (`csv`) or as an .xlsx, base64-encoded
 * (`xlsx`): JSON cannot carry the bytes, and a multipart upload would be a
 * second request shape for the same imports. The 5 MB JSON body limit
 * applies to both.
 */
class CsvBody {
  @IsOptional()
  @IsString()
  @MaxLength(5_000_000)
  csv?: string;

  @IsOptional()
  @IsBase64()
  @MaxLength(5_000_000)
  xlsx?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  filename?: string;
}

/** The uploaded file, from whichever of the two fields came. */
function fileOf(body: CsvBody): ImportFile {
  if (body?.xlsx) return { xlsx: Buffer.from(body.xlsx, "base64") };
  if (body?.csv) return body.csv;
  throw new BadRequestException("Falta el archivo (CSV o Excel .xlsx)");
}

/** The name the import job is recorded under. */
function nameOf(body: CsvBody): string {
  return body?.filename || (body?.xlsx ? "upload.xlsx" : "upload.csv");
}

class AppointmentsCsvBody extends CsvBody {
  /** false when the previous program still sends its own reminders. */
  @IsOptional()
  @IsBoolean()
  sendReminders?: boolean;
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
    return this.importService.dryRunClients(req.user.tenantId, fileOf(body), nameOf(body));
  }

  @Post("clients/commit")
  @Roles(...SALON_MANAGERS)
  async commit(@Req() req: AuthedRequest, @Body() body: CsvBody) {
    return this.importService.commitClients(req.user.tenantId, fileOf(body), nameOf(body));
  }

  @Post("services/dry-run")
  @Roles(...SALON_MANAGERS)
  async dryRunServices(@Req() req: AuthedRequest, @Body() body: CsvBody) {
    return this.importService.dryRunServices(req.user.tenantId, fileOf(body), nameOf(body));
  }

  @Post("services/commit")
  @Roles(...SALON_MANAGERS)
  async commitServices(@Req() req: AuthedRequest, @Body() body: CsvBody) {
    return this.importService.commitServices(req.user.tenantId, fileOf(body), nameOf(body));
  }

  @Post("appointments/dry-run")
  @Roles(...SALON_MANAGERS)
  async dryRunAppointments(@Req() req: AuthedRequest, @Body() body: AppointmentsCsvBody) {
    return this.importService.dryRunAppointments(req.user.tenantId, fileOf(body), nameOf(body), {
      sendReminders: body.sendReminders,
    });
  }

  @Post("appointments/commit")
  @Roles(...SALON_MANAGERS)
  async commitAppointments(@Req() req: AuthedRequest, @Body() body: AppointmentsCsvBody) {
    return this.importService.commitAppointments(req.user.tenantId, fileOf(body), nameOf(body), {
      sendReminders: body.sendReminders,
    });
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
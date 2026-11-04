import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
  StreamableFile,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import type { Response, Request } from "express";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { SaasOwnerGuard } from "../guards/saas-owner.guard";
import { SaasOwner } from "../decorators/saas-owner.decorator";
import { GdprConsoleService } from "./gdpr-console.service";
import { ConsoleAnonymizeDto } from "../dto/console-actions.dto";
import { clientIp } from "../../common/client-ip";

/**
 * GDPR data subject access endpoints (SaaS owner only).
 *
 * - `GET /api/v1/saas/tenants/:id/export` — Art. 15 RGPD right of
 *   access. A JSON envelope with a gzip+base64 bundle of every table of
 *   the salon; `?format=json` downloads the plain JSON instead (the
 *   console's button, audit 8 D14). The request is marked completed or
 *   failed.
 * - `POST /api/v1/saas/tenants/:id/anonymize` — Art. 17 RGPD right to
 *   erasure, with the salon's name typed as confirmation (and `force` for
 *   a salon still active). Invoices are kept; Stripe is cancelled first.
 * - `GET /api/v1/saas/tenants/:id/gdpr-requests` — the history.
 *
 * Every export and erasure writes a `GdprRequest` row (Art. 30 RGPD).
 */

@ApiTags("SaaS / GDPR")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SaasOwnerGuard)
@SaasOwner()
@Controller("saas/tenants")
export class GdprController {
  constructor(private readonly gdprConsole: GdprConsoleService) {}

  @Get(":id/export")
  @ApiOperation({
    summary:
      "Export all PII for a tenant (Art. 15 RGPD right of access). " +
      "A JSON envelope with a base64-encoded gzip bundle of every table, or the plain JSON with ?format=json.",
  })
  @ApiResponse({
    status: 200,
    description: "JSON envelope containing a gzip+base64 bundle of all tenant data, or the plain JSON",
  })
  async export(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("format") format?: string,
  ): Promise<StreamableFile> {
    const actorId = (req as any).user?.id ?? "unknown";
    const plain = format === "json";
    const { requestId, body } = await this.gdprConsole.export(id, actorId, clientIp(req), plain ? "json" : "envelope");
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="datos-rgpd-${id.slice(0, 8)}-${day}-${requestId.slice(0, 8)}.json"`,
    );
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return new StreamableFile(body);
  }

  @Post(":id/anonymize")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Right-to-erasure (Art. 17 RGPD). Replaces PII with placeholders. Invoice records preserved for fiscal compliance.",
  })
  @ApiResponse({
    status: 200,
    description: "Anonymization completed; request id returned",
  })
  async anonymize(
    @Req() req: Request,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: ConsoleAnonymizeDto,
  ): Promise<{ ok: true; requestId: string }> {
    const actorId = (req as any).user?.id ?? "unknown";
    return this.gdprConsole.anonymize(id, actorId, clientIp(req), body);
  }

  @Get(":id/gdpr-requests")
  @ApiOperation({ summary: "The salon's GDPR requests (export / anonymize), newest first" })
  async history(@Param("id", ParseUUIDPipe) id: string) {
    return this.gdprConsole.history(id);
  }
}

import {
  Controller,
  Get,
  Post,
  Param,
  ParseUUIDPipe,
  Res,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
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
import { GdprService } from "./gdpr.service";

/**
 * GDPR data subject access endpoints.
 *
 * - `GET /api/v1/saas/tenants/:id/export` — Art. 15 RGPD right of
 *   access. Returns a JSON envelope containing a gzip+base64 bundle
 *   of every model that references the tenant. SaaS owner only.
 * - `POST /api/v1/saas/tenants/:id/anonymize` — Art. 17 RGPD right
 *   to erasure. Soft-replaces PII in a single transaction. SaaS
 *   owner only.
 *
 * Every call writes a `GdprRequest` audit row (Art. 30 RGPD).
 */

@ApiTags("SaaS / GDPR")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SaasOwnerGuard)
@SaasOwner()
@Controller("saas/tenants")
export class GdprController {
  constructor(private readonly gdpr: GdprService) {}

  @Get(":id/export")
  @ApiOperation({
    summary:
      "Export all PII for a tenant (Art. 15 RGPD right of access). " +
      "Returns a JSON envelope with a base64-encoded gzip bundle of every model.",
  })
  @ApiResponse({
    status: 200,
    description: "JSON envelope containing a gzip+base64 bundle of all tenant data",
  })
  async export(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{ format: string; tenantId: string; sizeBytes: number; sha256: string; data: string }> {
    const actorId = (req as any).user?.id ?? "unknown";
    const ipAddress =
      (req.headers["x-forwarded-for"] as string) ?? req.ip;
    const rec = await this.gdpr.recordRequest(
      id,
      "export",
      actorId,
      ipAddress,
    );

    const envelope = JSON.parse(
      (await this.gdpr.export(id, rec.id)).toString("utf8"),
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="gdpr-export-${id}-${rec.id}.json"`,
    );
    res.setHeader("Content-Type", "application/json");
    return envelope;
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
  ): Promise<{ ok: true; requestId: string }> {
    const actorId = (req as any).user?.id ?? "unknown";
    const ipAddress =
      (req.headers["x-forwarded-for"] as string) ?? req.ip;
    const rec = await this.gdpr.recordRequest(
      id,
      "anonymize",
      actorId,
      ipAddress,
    );
    const updated = await this.gdpr.anonymize(id, rec.id);
    return { ok: true, requestId: updated.id };
  }
}

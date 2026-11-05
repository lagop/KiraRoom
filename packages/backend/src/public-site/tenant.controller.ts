import { Controller, Get, Param, NotFoundException, ParseUUIDPipe, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { Public } from "../auth/decorators/public.decorator";
import { PublicSiteService } from "./public-site.service";
import { IMAGE_RESPONSE_CSP, PUBLIC_IMAGE_KINDS, type PublicImageKind } from "./public-images";

/** A year: the URL carries the image's version, so a new upload is a new URL. */
const VERSIONED_MAX_AGE = 31_536_000;
/** Without (or with an old) version: short, so a new upload shows soon. */
const UNVERSIONED_MAX_AGE = 300;

@ApiTags("public")
// Public: the salon's own site resolves it before anyone signs in. It used
// to rely on a path prefix list in JwtAuthGuard; RolesGuard needs the
// decorator.
@Public()
@Controller("public-site")
export class PublicTenantController {
  // GET tenant/:slug is gone: nothing used it, and it answered the stored
  // logo (a data: URL of hundreds of KB) to anyone. The page data has
  // everything (page/:slug).
  constructor(private readonly site: PublicSiteService) {}

  @Get("page/:slug")
  @ApiOperation({ summary: "Everything the salon's public page renders: info, services, team, hours (public)" })
  @ApiResponse({ status: 404, description: "Salon not found" })
  page(@Param("slug") slug: string) {
    return this.site.getPage(slug);
  }

  /**
   * The salon's logo or cover photo as an image, for its page, its widget
   * and link previews (public-images.ts). Same answer for everyone, so it is
   * cached publicly; with the current `?v=` for a year.
   */
  @Get("image/:tenantId/:kind")
  @ApiOperation({ summary: "The salon's logo or cover photo (public, cacheable)" })
  @ApiResponse({ status: 404, description: "No such salon or no such image" })
  async image(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("kind") kind: string,
    @Query("v") v: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!PUBLIC_IMAGE_KINDS.includes(kind as PublicImageKind)) throw new NotFoundException("Image not found");
    sendImage(await this.site.image(tenantId, kind as PublicImageKind), v, req, res);
  }

  /** A professional's photo or portfolio picture, the same way (public-professional.ts). */
  @Get("professional-image/:professionalId/:slot")
  @ApiOperation({ summary: "A professional's public photo or portfolio picture (public, cacheable)" })
  @ApiResponse({ status: 404, description: "No such professional, picture, or not shown on the web" })
  async professionalImage(
    @Param("professionalId", ParseUUIDPipe) professionalId: string,
    @Param("slot") slot: string,
    @Query("v") v: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    sendImage(await this.site.professionalImage(professionalId, slot), v, req, res);
  }

  /** Who runs the salon, for its privacy page and aviso legal (public). */
  @Get("legal/:slug")
  @ApiOperation({ summary: "The salon's legal identity for its privacy page and aviso legal (public)" })
  @ApiResponse({ status: 404, description: "Salon not found" })
  @ApiResponse({ status: 410, description: "The salon's page is gone" })
  legal(@Param("slug") slug: string) {
    return this.site.legal(slug);
  }

  @Get("sitemap")
  @ApiOperation({ summary: "Active salons for the sitemap: slug, last change, live custom domain (public)" })
  sitemap() {
    return this.site.listForSitemap();
  }

  @Get("domain/:host")
  @ApiOperation({ summary: "Which salon a verified custom domain serves (public)" })
  @ApiResponse({ status: 404, description: "No verified salon for that host" })
  domain(@Param("host") host: string) {
    return this.site.resolveHost(host);
  }

  /**
   * The "ask" hook of an on-demand TLS front (Caddy's on_demand_tls sends
   * `?domain=`): 200 only for verified domains, so nobody can make us
   * request certificates for arbitrary hosts. See docs/custom-domains.md.
   */
  @Get("domain-check")
  @ApiOperation({ summary: "200 if the domain may get a certificate (verified), 404 otherwise (public)" })
  async domainCheck(@Query("domain") domain: string) {
    await this.site.resolveHost(domain ?? "");
    return { ok: true };
  }
}

/**
 * Answers an image from the service (null: 404) with the headers every
 * public image gets: an ETag (304 when it matches), a long cache only for
 * the current version, nosniff and a CSP that runs nothing (SVG).
 */
function sendImage(
  image: { contentType: string; body: Buffer; version: string } | null,
  v: string | undefined,
  req: Request,
  res: Response,
): void {
  if (!image) throw new NotFoundException("Image not found");
  const etag = `"${image.version}"`;
  const maxAge = v === image.version ? VERSIONED_MAX_AGE : UNVERSIONED_MAX_AGE;
  res.setHeader("Cache-Control", `public, max-age=${maxAge}${maxAge === VERSIONED_MAX_AGE ? ", immutable" : ""}`);
  res.setHeader("ETag", etag);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", IMAGE_RESPONSE_CSP);
  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return;
  }
  res.setHeader("Content-Type", image.contentType);
  res.send(image.body);
}

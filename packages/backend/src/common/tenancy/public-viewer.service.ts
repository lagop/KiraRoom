import { BadRequestException, Injectable, Module, UnauthorizedException } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { PrismaService } from "../prisma/prisma.service";

/** Who is asking a public list endpoint, and for which salon. */
export interface PublicViewer {
  tenantId: string;
  /**
   * An active owner/admin/staff member of THIS salon. Only they get full
   * rows; everyone else -- anonymous visitors, clients, staff of another
   * salon -- gets the public projection.
   */
  staff: boolean;
}

const STAFF_ROLES = new Set(["owner", "admin", "staff"]);

/**
 * Resolves the viewer for @Public() list and detail endpoints
 * (GET /services, GET /professionals, GET /professionals/:id).
 *
 * @Public() skips the JWT guard entirely, so no tenant was bound, the tenant
 * scope did not apply, and these routes answered with every salon's rows --
 * professionals with email, phone and commission rate -- to anyone.
 *
 * The token is verified with the app's JwtService and JWT_SECRET, as
 * JwtStrategy does, and the user is re-read so a deactivated account is not
 * "staff". It deliberately does not run the guard: that would bind the
 * caller's tenant, and salon B's public page would then answer 403 to
 * someone logged into salon A.
 */
@Injectable()
export class PublicViewerService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Tenant resolution, in order:
   * 1. An explicit `?tenantId=`: the public site asking for its own salon.
   * 2. The tenant of a valid bearer token: the dashboard and client portal.
   * 3. Otherwise 400 (no token) or 401 (bad token), and nothing is listed.
   *
   * A bad token next to an explicit tenantId is treated as anonymous rather
   * than rejected: a stale session must not break a salon's public page.
   */
  async resolve(req: { headers?: Record<string, unknown> }, queryTenantId?: string): Promise<PublicViewer> {
    const claims = this.readToken(req);

    if (queryTenantId) {
      const staff = claims.valid ? await this.isStaffOf(claims.payload, queryTenantId) : false;
      return { tenantId: queryTenantId, staff };
    }

    if (!claims.present) throw new BadRequestException("tenantId is required");
    if (!claims.valid) throw new UnauthorizedException("Invalid or expired token");

    const tenantId = claims.payload.tenantId;
    if (typeof tenantId !== "string" || !tenantId) {
      // A saas_owner token carries no tenant; it must say which one it means.
      throw new BadRequestException("tenantId is required");
    }
    return { tenantId, staff: await this.isStaffOf(claims.payload, tenantId) };
  }

  private readToken(req: { headers?: Record<string, unknown> }):
    | { present: false; valid: false }
    | { present: true; valid: false }
    | { present: true; valid: true; payload: Record<string, any> } {
    const header = req.headers?.authorization;
    const match = typeof header === "string" ? /^Bearer\s+(.+)$/i.exec(header) : null;
    if (!match) return { present: false, valid: false };
    try {
      const payload = this.jwt.verify(match[1], {
        secret: this.config.get<string>("JWT_SECRET"),
      });
      return { present: true, valid: true, payload };
    } catch {
      return { present: true, valid: false };
    }
  }

  private async isStaffOf(payload: Record<string, any>, tenantId: string): Promise<boolean> {
    if (!STAFF_ROLES.has(payload.role) || payload.tenantId !== tenantId) return false;
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { isActive: true, tenantId: true },
    });
    return !!user?.isActive && user.tenantId === tenantId;
  }
}

@Module({
  imports: [ConfigModule, JwtModule.register({})],
  providers: [PublicViewerService],
  exports: [PublicViewerService],
})
export class PublicViewerModule {}

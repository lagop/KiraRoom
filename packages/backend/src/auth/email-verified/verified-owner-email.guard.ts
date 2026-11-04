import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { EMAIL_NOT_VERIFIED_CODE, EMAIL_NOT_VERIFIED_MESSAGE, tenantOwnerEmailVerified } from "./owner-email-verified";

/**
 * D1: put on the routes that send to many clients at once or connect the
 * salon's Stripe account. 403 EMAIL_NOT_VERIFIED until the salon's owner
 * has confirmed their email. Runs after the auth guards (it needs the
 * signed-in user's tenant); a request without one is left to them.
 */
@Injectable()
export class VerifiedOwnerEmailGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const tenantId: string | undefined = ctx.switchToHttp().getRequest()?.user?.tenantId;
    if (!tenantId) return true;
    if (await tenantOwnerEmailVerified(this.prisma, tenantId)) return true;
    throw new ForbiddenException({
      statusCode: 403,
      code: EMAIL_NOT_VERIFIED_CODE,
      message: EMAIL_NOT_VERIFIED_MESSAGE,
    });
  }
}

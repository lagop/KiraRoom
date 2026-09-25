import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { TenantContextMiddleware } from "./tenant-context.middleware";

/**
 * Wires the per-request tenant context for the whole app. Paired with
 * the Prisma `tenant-scope` extension applied in `PrismaService`.
 */
@Module({})
export class TenancyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantContextMiddleware).forRoutes("*");
  }
}

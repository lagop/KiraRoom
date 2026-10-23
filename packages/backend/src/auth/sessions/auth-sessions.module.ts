import { Global, Module } from "@nestjs/common";
import { PrismaModule } from "../../common/prisma/prisma.module";
import { AuthSessionsService } from "./auth-sessions.service";

/** Global: sign-in, refresh and invite acceptance all start or rotate sessions. */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [AuthSessionsService],
  exports: [AuthSessionsService],
})
export class AuthSessionsModule {}

import { Module } from "@nestjs/common";
import { IcsController } from "./ics.controller";

@Module({
  controllers: [IcsController],
})
export class IcsFeedsModule {}
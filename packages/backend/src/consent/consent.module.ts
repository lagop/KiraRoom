import { Module } from "@nestjs/common";
import { ConsentService } from "./consent.service";
import {
  ConsentFormsController,
  ConsentController,
} from "./consent.controller";

@Module({
  controllers: [ConsentFormsController, ConsentController],
  providers: [ConsentService],
  exports: [ConsentService],
})
export class ConsentModule {}
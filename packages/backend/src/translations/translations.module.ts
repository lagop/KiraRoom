import { Module } from "@nestjs/common";
import { TranslationsService } from "./translations.service";

@Module({
  providers: [TranslationsService],
  exports: [TranslationsService],
})
export class TranslationsModule {}

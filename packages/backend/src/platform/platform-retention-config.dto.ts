import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean } from "class-validator";

export class UpdatePlatformRetentionConfigDto {
  @ApiProperty({ description: "true: the retention job warns and anonymises for real. false: dry run." })
  @IsBoolean()
  enabled!: boolean;
}

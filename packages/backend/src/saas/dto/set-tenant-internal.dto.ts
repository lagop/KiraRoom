import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean } from "class-validator";

export class SetTenantInternalDto {
  @ApiProperty({ description: "true for one of KiraRoom's own salons (Platform tenant, test salons)" })
  @IsBoolean()
  isInternal!: boolean;
}

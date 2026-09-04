import { IsNotEmpty, MinLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class ChangeProfessionalPasswordDto {
  @ApiProperty({
    description: "New password for the professional",
    example: "newPassword123",
  })
  @IsNotEmpty({ message: "New password is required" })
  @MinLength(6, { message: "Password must be at least 6 characters long" })
  newPassword: string;
}

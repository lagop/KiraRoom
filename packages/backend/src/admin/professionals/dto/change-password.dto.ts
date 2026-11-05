import { IsNotEmpty, MaxLength, MinLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class ChangeProfessionalPasswordDto {
  @ApiProperty({
    description: "New password for the professional",
    example: "newPassword123",
  })
  @IsNotEmpty({ message: "New password is required" })
  // Same minimum as signing in (LoginDto): 6 let a password be set that could never log in.
  @MinLength(8, { message: "La contraseña debe tener al menos 8 caracteres" })
  @MaxLength(200)
  newPassword: string;
}

/** First password for a professional's panel login; the owner hands it over. */
export class GrantPanelAccessDto {
  @ApiProperty({ description: "First password for the professional's login", example: "una-clave-larga" })
  @IsNotEmpty()
  @MinLength(8, { message: "La contraseña debe tener al menos 8 caracteres" })
  @MaxLength(200)
  password: string;
}

import { ApiPropertyOptional, ApiProperty } from "@nestjs/swagger";
import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";
import { CONSOLE_DTO_MESSAGES as MSG } from "./console-dto-messages";

/** POST /saas/tenants/:id/reactivate (audit 8 T4). */
export class ReactivateTenantDto {
  /** The owner asked "Borrar mi salón": reactivating cancels it only when this is true. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: MSG.boolean("anular el borrado pendiente") })
  cancelDeletion?: boolean;
}

/** POST /saas/tenants/:id/anonymize (audit 8 T5). */
export class ConsoleAnonymizeDto {
  /** The salon's name, typed by hand: the confirmation. */
  @ApiProperty({ example: "Glamour Studio" })
  @IsString({ message: "Escribe el nombre del salón para confirmar." })
  @MaxLength(300, { message: "El nombre es demasiado largo." })
  confirmName: string;

  /** Needed for a salon that is still active, on trial or with a payment pending. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: MSG.boolean("anonimizar aunque el salón siga activo") })
  force?: boolean;
}

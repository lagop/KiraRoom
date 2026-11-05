import { ApiPropertyOptional, ApiProperty } from "@nestjs/swagger";
import { IsBoolean, IsDate, IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { Type } from "class-transformer";
import { SubscriptionPlan } from "@prisma/client";
import { CONSOLE_DTO_MESSAGES as MSG } from "./console-dto-messages";

/** POST /saas/tenants/:id/courtesy (audit 8 D6): active without paying, on a plan, until a date. */
export class CourtesyTenantDto {
  @ApiProperty({ enum: SubscriptionPlan, example: "pro" })
  @IsEnum(SubscriptionPlan, { message: MSG.plan })
  plan: SubscriptionPlan;

  @ApiProperty({ type: Date, example: "2026-12-31" })
  @Type(() => Date)
  @IsDate({ message: MSG.date("fin de la cortesía") })
  until: Date;

  /** The owner asked "Borrar mi salón": the courtesy cancels it only when this is true (audit 8 T4). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: MSG.boolean("anular el borrado pendiente") })
  cancelDeletion?: boolean;
}

/** POST /saas/tenants/:id/block (audit 8 D4, abuse). */
export class BlockTenantDto {
  /** Why, for the audit log and the console. Never shown to the salon. */
  @ApiProperty({ example: "Envíos de spam" })
  @IsString({ message: "Escribe el motivo del bloqueo." })
  @IsNotEmpty({ message: "Escribe el motivo del bloqueo." })
  @MaxLength(500, { message: "El motivo puede tener como mucho 500 caracteres." })
  reason: string;
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

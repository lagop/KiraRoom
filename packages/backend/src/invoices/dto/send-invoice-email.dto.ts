import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsOptional, MaxLength } from "class-validator";
import { Transform } from "class-transformer";

/**
 * Body of `POST /invoices/:id/email`. Without `to`, the invoice goes to its
 * client's email.
 */
export class SendInvoiceEmailDto {
  @ApiPropertyOptional({ description: "Address to send it to; left out, the client's email" })
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() || undefined : value))
  @IsEmail({}, { message: "El email no es válido" })
  @MaxLength(254)
  to?: string;
}

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsIn, IsOptional, IsString, Length, Matches } from "class-validator";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export class UpdateAccountingSettingsDto {
  @ApiPropertyOptional({ description: "Send each invoice to Holded as soon as it is issued" })
  @IsOptional()
  @IsBoolean()
  syncOnIssue?: boolean;
}

export class ConnectHoldedDto {
  @ApiProperty({ description: "API key generated in Holded > Ajustes > API" })
  @IsString()
  @Length(10, 300)
  @Matches(/^\S+$/, { message: "La clave API no puede contener espacios" })
  apiKey!: string;
}

export class SyncInvoiceDto {
  @ApiProperty()
  @IsString()
  invoiceId!: string;
}

export class PushPendingDto {
  @ApiPropertyOptional({ description: "YYYY-MM-DD: also send invoices issued since this day" })
  @IsOptional()
  @Matches(ISO_DAY, { message: "from debe tener el formato AAAA-MM-DD" })
  from?: string;
}

export class InvoiceBookQueryDto {
  @ApiProperty({ example: "2026-07-01" })
  @Matches(ISO_DAY, { message: "from debe tener el formato AAAA-MM-DD" })
  from!: string;

  @ApiProperty({ example: "2026-09-30" })
  @Matches(ISO_DAY, { message: "to debe tener el formato AAAA-MM-DD" })
  to!: string;

  @ApiPropertyOptional({ enum: ["csv", "xlsx"], default: "xlsx" })
  @IsOptional()
  @IsIn(["csv", "xlsx"])
  format?: "csv" | "xlsx";
}

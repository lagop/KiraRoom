import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";
import { BugReportStatus } from "@prisma/client";

export class UpdateBugReportDto {
  @IsEnum(BugReportStatus)
  status!: BugReportStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  resolution?: string;
}

export class ListBugReportsQueryDto {
  @IsOptional()
  @IsEnum(BugReportStatus)
  status?: BugReportStatus;

  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsString()
  search?: string;
}
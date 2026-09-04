import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class OnboardingStepDefDto {
  @ApiProperty()
  key!: string;

  @ApiProperty()
  order!: number;

  @ApiProperty({ enum: ["linear_required", "linear_optional", "checklist_optional"] })
  group!: "linear_required" | "linear_optional" | "checklist_optional";

  @ApiProperty()
  titleI18nKey!: string;

  @ApiProperty()
  descI18nKey!: string;

  @ApiPropertyOptional()
  href?: string;

  @ApiProperty()
  detectName!: string;

  @ApiProperty()
  enabled!: boolean;
}

export class OnboardingStepStatusDto {
  @ApiProperty({ enum: ["pending", "done", "skipped", "dismissed"] })
  status!: "pending" | "done" | "skipped" | "dismissed";

  @ApiPropertyOptional()
  completedAt?: string;

  @ApiPropertyOptional()
  skippedAt?: string;

  @ApiPropertyOptional()
  dismissedAt?: string;
}

export class OnboardingStateDto {
  @ApiProperty()
  currentStep!: number;

  @ApiProperty({ type: "object", additionalProperties: { $ref: "#/components/schemas/OnboardingStepStatusDto" } })
  steps!: Record<string, OnboardingStepStatusDto>;

  @ApiProperty()
  checklistDismissed!: boolean;

  @ApiPropertyOptional()
  finishedAt?: string;

  @ApiProperty({ type: [OnboardingStepDefDto] })
  defs!: OnboardingStepDefDto[];

  @ApiProperty({ type: "object", additionalProperties: { type: "boolean" } })
  detectResults!: Record<string, boolean>;
}
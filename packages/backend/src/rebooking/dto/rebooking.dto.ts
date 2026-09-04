import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
} from "class-validator";

export class UpdateRebookingConfigDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 7 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7)
  leadDays?: number;

  @ApiPropertyOptional({ enum: ["email", "whatsapp", "both"] })
  @IsOptional()
  @IsIn(["email", "whatsapp", "both"])
  channelFallback?: "email" | "whatsapp" | "both";

  @ApiPropertyOptional({ minimum: 1, maximum: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  minVisits?: number;
}

export interface RebookingConfigDto {
  enabled: boolean;
  leadDays: number;
  channelFallback: "email" | "whatsapp" | "both";
  minVisits: number;
}

export interface ClientCadencePredictionDto {
  clientId: string;
  byService: Record<
    string,
    {
      avgDays: number;
      stdDevDays: number;
      lastVisit: string;
      visitsCount: number;
      nextExpectedAt: string;
    }
  >;
  nextRecommendedReminderAt: string | null;
  recommendedServiceId: string | null;
  reminderSentFor: Array<{
    serviceId: string;
    sentAt: string;
    channel: "email" | "whatsapp" | "both";
  }>;
  optedOut: boolean;
  lastComputedAt: string;
}

export interface RebookingReminderDto {
  id: string;
  clientId: string;
  serviceId: string | null;
  scheduledAt: string;
  sentAt: string | null;
  channel: "email" | "whatsapp" | "both";
  status: "scheduled" | "sent" | "cancelled" | "failed" | "booked";
  resultAppointmentId: string | null;
  cancelledReason: string | null;
  createdAt: string;
}
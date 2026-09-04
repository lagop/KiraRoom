import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsBoolean, IsDateString, IsArray, IsEmail, IsNumber, Min, Max } from 'class-validator';

export enum CampaignType {
  newsletter = 'newsletter',
  promotion = 'promotion',
  announcement = 'announcement',
  reminder = 'reminder',
  review_request = 'review_request',
  loyalty = 'loyalty',
  reengagement = 'reengagement',
  custom = 'custom',
}

export class CreateCampaignDto {
  @ApiProperty({ description: 'Campaign name', example: 'Summer Sale' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Email subject', example: '🎉 Special Offer Just for You!' })
  @IsString()
  subject: string;

  @ApiPropertyOptional({ description: 'Preview text', example: 'Get 20% off your next visit' })
  @IsString()
  @IsOptional()
  previewText?: string;

  @ApiProperty({ description: 'HTML content', example: '<h1>Hello!</h1><p>Special offer...</p>' })
  @IsString()
  content: string;

  @ApiProperty({ enum: CampaignType, example: CampaignType.promotion })
  @IsEnum(CampaignType)
  campaignType: CampaignType;

  @ApiPropertyOptional({ description: 'Sender name' })
  @IsString()
  @IsOptional()
  fromName?: string;

  @ApiPropertyOptional({ description: 'Reply-to email' })
  @IsEmail()
  @IsOptional()
  replyTo?: string;

  // Re-engagement campaign fields
  @ApiPropertyOptional({ description: 'Days of inactivity to target (e.g., 30, 60, 90)', example: 30 })
  @IsNumber()
  @IsOptional()
  @Min(1)
  @Max(365)
  inactiveDaysThreshold?: number;

  @ApiPropertyOptional({ description: 'ID of promotion to include in email' })
  @IsString()
  @IsOptional()
  linkedPromotionId?: string;
}

export class UpdateCampaignDto {
  @ApiPropertyOptional({ description: 'Campaign name' })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ description: 'Email subject' })
  @IsString()
  @IsOptional()
  subject?: string;

  @ApiPropertyOptional({ description: 'Preview text' })
  @IsString()
  @IsOptional()
  previewText?: string;

  @ApiPropertyOptional({ description: 'HTML content' })
  @IsString()
  @IsOptional()
  content?: string;

  @ApiPropertyOptional({ enum: CampaignType })
  @IsEnum(CampaignType)
  @IsOptional()
  campaignType?: CampaignType;

  @ApiPropertyOptional({ description: 'Sender name' })
  @IsString()
  @IsOptional()
  fromName?: string;

  @ApiPropertyOptional({ description: 'Reply-to email' })
  @IsEmail()
  @IsOptional()
  replyTo?: string;
}

export class CreateTemplateDto {
  @ApiProperty({ description: 'Template name', example: 'Newsletter Template' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Email subject' })
  @IsString()
  subject: string;

  @ApiPropertyOptional({ description: 'Preview text' })
  @IsString()
  @IsOptional()
  previewText?: string;

  @ApiProperty({ description: 'HTML content' })
  @IsString()
  content: string;

  @ApiPropertyOptional({ enum: CampaignType })
  @IsEnum(CampaignType)
  @IsOptional()
  campaignType?: CampaignType;

  @ApiPropertyOptional({ description: 'Set as default template' })
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}

export class SendCampaignDto {
  @ApiProperty({ description: 'Campaign name' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Email subject' })
  @IsString()
  subject: string;

  @ApiPropertyOptional({ description: 'Preview text' })
  @IsString()
  @IsOptional()
  previewText?: string;

  @ApiProperty({ description: 'HTML content' })
  @IsString()
  content: string;

  @ApiProperty({ enum: CampaignType })
  @IsEnum(CampaignType)
  campaignType: CampaignType;

  @ApiPropertyOptional({ description: 'Send immediately' })
  @IsBoolean()
  @IsOptional()
  sendNow?: boolean;

  @ApiPropertyOptional({ description: 'Sender name' })
  @IsString()
  @IsOptional()
  fromName?: string;

  @ApiPropertyOptional({ description: 'Reply-to email' })
  @IsEmail()
  @IsOptional()
  replyTo?: string;
}

export class AddRecipientsDto {
  @ApiProperty({ type: [String], description: 'Client IDs' })
  @IsArray()
  @IsString({ each: true })
  clientIds: string[];
}

export class ScheduleCampaignDto {
  @ApiProperty({ description: 'Scheduled date/time', example: '2024-12-25T10:00:00Z' })
  @IsDateString()
  scheduledAt: string;
}

export class CreateReengagementCampaignDto {
  @ApiProperty({ description: 'Campaign name', example: 'We Miss You Campaign' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Email subject', example: '😢 We miss you! Come back for 20% off' })
  @IsString()
  subject: string;

  @ApiPropertyOptional({ description: 'Preview text', example: 'Get a special discount on your next visit' })
  @IsString()
  @IsOptional()
  previewText?: string;

  @ApiProperty({ description: 'HTML content', example: '<h1>We miss you!</h1><p>Come back for 20% off...</p>' })
  @IsString()
  content: string;

  @ApiProperty({ description: 'Days of inactivity to target (e.g., 30, 60, 90)', example: 30 })
  @IsNumber()
  @Min(1)
  @Max(365)
  inactiveDaysThreshold: number;

  @ApiPropertyOptional({ description: 'ID of promotion to include in email' })
  @IsString()
  @IsOptional()
  linkedPromotionId?: string;

  @ApiPropertyOptional({ description: 'Sender name' })
  @IsString()
  @IsOptional()
  fromName?: string;

  @ApiPropertyOptional({ description: 'Reply-to email' })
  @IsEmail()
  @IsOptional()
  replyTo?: string;
}

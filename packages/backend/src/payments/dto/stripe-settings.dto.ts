import { IsString, IsOptional, IsIn, ValidateIf } from 'class-validator';

export class UpdateStripeSettingsDto {
  @IsIn(['test', 'live'])
  @IsOptional()
  stripeMode?: 'test' | 'live';

  @IsString()
  @ValidateIf((o) => o.stripeMode === 'test' || !o.stripeMode)
  @IsOptional()
  stripeTestSecretKey?: string;

  @IsString()
  @ValidateIf((o) => o.stripeMode === 'test' || !o.stripeMode)
  @IsOptional()
  stripeTestPublishableKey?: string;

  @IsString()
  @ValidateIf((o) => o.stripeMode === 'live' || !o.stripeMode)
  @IsOptional()
  stripeLiveSecretKey?: string;

  @IsString()
  @ValidateIf((o) => o.stripeMode === 'live' || !o.stripeMode)
  @IsOptional()
  stripeLivePublishableKey?: string;
}

export class StripeSettingsResponseDto {
  stripeMode: 'test' | 'live';
  stripeTestSecretKey: string | null;
  stripeTestPublishableKey: string | null;
  stripeLiveSecretKey: string | null;
  stripeLivePublishableKey: string | null;
  isConfigured: boolean;
}

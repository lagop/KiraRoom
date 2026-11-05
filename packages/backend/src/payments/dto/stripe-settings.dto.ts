import { IsString, IsOptional, IsIn, MaxLength } from 'class-validator';

/**
 * PATCH /payments/stripe/settings. A secret key sent back as the page got it
 * (masked, `sk_live_…1234`) leaves the stored one as it is; an empty string
 * clears it (StripeService.updateTenantSettings, stripe-keys.ts).
 */
export class UpdateStripeSettingsDto {
  @IsIn(['test', 'live'])
  @IsOptional()
  stripeMode?: 'test' | 'live';

  @IsString()
  @MaxLength(500)
  @IsOptional()
  stripeTestSecretKey?: string;

  @IsString()
  @MaxLength(500)
  @IsOptional()
  stripeTestPublishableKey?: string;

  @IsString()
  @MaxLength(500)
  @IsOptional()
  stripeLiveSecretKey?: string;

  @IsString()
  @MaxLength(500)
  @IsOptional()
  stripeLivePublishableKey?: string;
}

export class StripeSettingsResponseDto {
  stripeMode: 'test' | 'live';
  /** Masked (`sk_test_…1234`), never the key itself. */
  stripeTestSecretKey: string | null;
  stripeTestPublishableKey: string | null;
  /** Masked (`sk_live_…1234`), never the key itself. */
  stripeLiveSecretKey: string | null;
  stripeLivePublishableKey: string | null;
  testSecretKeyConfigured: boolean;
  liveSecretKeyConfigured: boolean;
  isConfigured: boolean;
}

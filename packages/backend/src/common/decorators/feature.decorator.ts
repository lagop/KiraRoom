import { SetMetadata } from '@nestjs/common';
import { FeatureKey } from '../../payments/services/subscriptions.service';

export const FEATURE_KEY_METADATA = 'featureKey';

/**
 * Mark a controller method as requiring a specific feature in the active
 * plan. Combine with `FeatureGuard` in the controller to enforce the gate.
 *
 * Example:
 *   @Post('campaigns')
 *   @Feature('email_marketing')
 *   create(...) { ... }
 */
export const Feature = (key: FeatureKey) => SetMetadata(FEATURE_KEY_METADATA, key);

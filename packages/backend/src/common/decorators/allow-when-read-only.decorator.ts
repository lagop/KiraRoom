import { SetMetadata } from '@nestjs/common';

export const ALLOW_WHEN_READ_ONLY = 'allowWhenReadOnly';

/**
 * Lets a write route through for a salon in read-only mode (trial ended,
 * subscription cancelled or suspended): what it needs to pay, sign out or
 * keep its account safe. Everything else that writes is refused by
 * ReadOnlyTenantGuard.
 */
export const AllowWhenReadOnly = () => SetMetadata(ALLOW_WHEN_READ_ONLY, true);

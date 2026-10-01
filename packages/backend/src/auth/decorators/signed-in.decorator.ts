import { SetMetadata } from '@nestjs/common';

export const SIGNED_IN_KEY = 'signedIn';

/**
 * Open to anyone with a session, whatever their role -- clients included.
 *
 * RolesGuard denies a route that declares nothing, so a route meant for
 * every signed-in user (their own profile, logging out) has to say so.
 * Anything that reads or changes salon data wants @Roles instead.
 */
export const SignedIn = () => SetMetadata(SIGNED_IN_KEY, true);

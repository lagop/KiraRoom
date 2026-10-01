import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@prisma/client';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/** Whoever runs the salon: what touches money, settings or the client base. */
export const SALON_MANAGERS: UserRole[] = [UserRole.owner, UserRole.admin];

/** Everyone who works in the salon, staff included: the day-to-day screens. */
export const SALON_TEAM: UserRole[] = [UserRole.owner, UserRole.admin, UserRole.staff];

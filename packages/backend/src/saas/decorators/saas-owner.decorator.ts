import { SetMetadata } from '@nestjs/common';

export const SAAS_OWNER_KEY = 'saas_owner';
export const SaasOwner = () => SetMetadata(SAAS_OWNER_KEY, true);
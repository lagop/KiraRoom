// Local-development entry point. The implementation lives in
// `src/scripts/seed-saas-owner.ts` so that `npm run build` compiles it into
// `dist/` and it can be run in the production image with plain `node` --
// ts-node and typescript are devDependencies and are not installed there.
import { seedSaasOwner } from '../src/scripts/seed-saas-owner';

seedSaasOwner().catch((err: Error) => {
  console.error(`[seed:saas] ${err.message}`);
  process.exitCode = 1;
});

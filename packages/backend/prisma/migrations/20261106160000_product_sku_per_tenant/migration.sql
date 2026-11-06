-- A product's SKU is unique within its salon, not across the platform: one
-- salon's SKU blocked every other salon from using it and told them it existed.
-- Relaxing a unique index cannot fail on existing data.
DROP INDEX IF EXISTS "products_sku_key";
CREATE UNIQUE INDEX "products_tenantId_sku_key" ON "products"("tenantId", "sku");

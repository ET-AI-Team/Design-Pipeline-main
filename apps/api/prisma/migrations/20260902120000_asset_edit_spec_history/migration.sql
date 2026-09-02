-- Adds the spec/patch/verification history columns /edit needs to build
-- each version on the previous one instead of re-patching the original.
-- All four are nullable and additive: existing rows are untouched.
--
-- Hand-written on purpose. `prisma migrate diff` against this database
-- also proposed dropping 7 tables (approval_decisions, assets, brands,
-- campaign_requests, scenarios, style_dimension_references, styles) that
-- exist live but are not modelled in schema.prisma. Those are NOT ours to
-- remove, so only the additive statement below is applied.
ALTER TABLE "AssetEdit" ADD COLUMN     "lane" TEXT,
ADD COLUMN     "patchJson" JSONB,
ADD COLUMN     "specJson" JSONB,
ADD COLUMN     "verificationJson" JSONB;

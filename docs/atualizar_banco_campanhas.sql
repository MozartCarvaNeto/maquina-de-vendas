-- Turbo Prospect — Campanhas inteligentes (origem do lead, robô guiado, catálogo)
-- Rode no SQL Editor do Supabase (seguro rodar mais de uma vez).
-- Alternativa: "npx prisma db push" (o script deploy/atualizar-servidor.sh --banco já faz isso).

ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "sourceType" TEXT NOT NULL DEFAULT 'outro';
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "triggerKeywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "adSourceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "isDefault" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "botConfig" JSONB;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "botEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "catalogUrl" TEXT;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "catalogText" TEXT;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "catalogWebText" TEXT;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "catalogFetchedAt" TIMESTAMP(3);

ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "sourceDetail" TEXT;

CREATE INDEX IF NOT EXISTS "leads_userId_campaignId_idx" ON "leads"("userId", "campaignId");

ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "whatsappConnectionId" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "lastConnectionId" TEXT;

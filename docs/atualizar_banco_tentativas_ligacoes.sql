-- Tentativas de ligação da IA (campanhas): quantas vezes tentar cada número e o intervalo entre tentativas.
-- Pode rodar mais de uma vez sem problema.
ALTER TABLE "ai_call_campaigns" ADD COLUMN IF NOT EXISTS "maxAttempts" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "ai_call_campaigns" ADD COLUMN IF NOT EXISTS "retryGapMinutes" INTEGER NOT NULL DEFAULT 180;

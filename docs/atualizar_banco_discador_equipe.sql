-- Turbo Prospect - Discador automático com equipe: pausa individual de cada vendedor.
-- Seguro para rodar mais de uma vez.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "isPaused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "pausedAt" TIMESTAMP(3);

-- Saldo pré-pago, webhook de SMS e custo de chamadas. Cole no SQL Editor do Supabase e clique em RUN.
-- (rode antes: atualizar_banco_pbx.sql)
CREATE TABLE IF NOT EXISTS "wallets" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT false,
  "balanceBrl" DOUBLE PRECISION NOT NULL DEFAULT 0, "voiceOutPerMinBrl" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "voiceInPerMinBrl" DOUBLE PRECISION NOT NULL DEFAULT 0, "voiceIncrementSec" INTEGER NOT NULL DEFAULT 60,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "wallets_userId_key" ON "wallets"("userId");
CREATE TABLE IF NOT EXISTS "wallet_txs" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "type" TEXT NOT NULL, "amountBrl" DOUBLE PRECISION NOT NULL,
  "balanceAfter" DOUBLE PRECISION NOT NULL, "description" TEXT NOT NULL, "refId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "wallet_txs_userId_createdAt_idx" ON "wallet_txs"("userId","createdAt");
ALTER TABLE "sms_messages" ADD COLUMN IF NOT EXISTS "callbackUrl" TEXT;
ALTER TABLE "sms_api_keys" ADD COLUMN IF NOT EXISTS "webhookUrl" TEXT;
ALTER TABLE "pbx_calls" ADD COLUMN IF NOT EXISTS "costBrl" DOUBLE PRECISION NOT NULL DEFAULT 0;

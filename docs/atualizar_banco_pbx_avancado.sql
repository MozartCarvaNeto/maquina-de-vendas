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

-- Números (DID) da plataforma atribuídos aos clientes
CREATE TABLE IF NOT EXISTS "pbx_dids" (
  "id" TEXT PRIMARY KEY,
  "number" TEXT NOT NULL UNIQUE,
  "accountId" TEXT,
  "label" TEXT,
  "assignedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "pbx_dids_accountId_idx" ON "pbx_dids" ("accountId");

-- Mensalidade dos números (cobrança no saldo, carência e suspensão)
ALTER TABLE "pbx_dids" ADD COLUMN IF NOT EXISTS "monthlyFeeBrl" DOUBLE PRECISION;
ALTER TABLE "pbx_dids" ADD COLUMN IF NOT EXISTS "nextBillAt" TIMESTAMP(3);
ALTER TABLE "pbx_dids" ADD COLUMN IF NOT EXISTS "lastBilledAt" TIMESTAMP(3);
ALTER TABLE "pbx_dids" ADD COLUMN IF NOT EXISTS "overdueSince" TIMESTAMP(3);
ALTER TABLE "pbx_dids" ADD COLUMN IF NOT EXISTS "suspendedAt" TIMESTAMP(3);

-- Recarga pelo cliente, aviso de saldo baixo e painel de lucro
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "lowBalanceBrl" DOUBLE PRECISION;
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "lowNotifiedAt" TIMESTAMP(3);
ALTER TABLE "wallet_txs" ADD COLUMN IF NOT EXISTS "costBrl" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "wallet_txs" ADD COLUMN IF NOT EXISTS "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS "wallet_topups" (
  "id" TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "asaasPaymentId" TEXT UNIQUE,
  "invoiceUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS "wallet_topups_accountId_createdAt_idx" ON "wallet_topups"("accountId","createdAt");

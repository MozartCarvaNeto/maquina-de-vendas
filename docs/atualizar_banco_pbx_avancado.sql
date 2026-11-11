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

-- ===== Termos, dados fiscais, notas, lista de bloqueio e limites de telefonia do plano =====
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "maxMonthlySms" INTEGER;
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "maxMonthlyVoiceMinutes" INTEGER;
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "maxDids" INTEGER;
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "maxAiAgents" INTEGER;

ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "termsAcceptedAt" TIMESTAMP(3);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "termsVersion" TEXT;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "termsAcceptedIp" TEXT;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "legalName" TEXT;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "taxId" TEXT;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "fiscalEmail" TEXT;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "fiscalAddress" TEXT;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "onboardingDismissed" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "billing_payments" ADD COLUMN IF NOT EXISTS "nfseNumber" TEXT;
ALTER TABLE "billing_payments" ADD COLUMN IF NOT EXISTS "nfseUrl" TEXT;
ALTER TABLE "wallet_topups" ADD COLUMN IF NOT EXISTS "nfseNumber" TEXT;
ALTER TABLE "wallet_topups" ADD COLUMN IF NOT EXISTS "nfseUrl" TEXT;

CREATE TABLE IF NOT EXISTS "opt_outs" (
  "id" TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "phone" TEXT NOT NULL,
  "channel" TEXT NOT NULL DEFAULT 'all',
  "source" TEXT NOT NULL DEFAULT 'manual',
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "opt_outs_accountId_phone_channel_key" ON "opt_outs"("accountId","phone","channel");
CREATE INDEX IF NOT EXISTS "opt_outs_accountId_phone_idx" ON "opt_outs"("accountId","phone");

-- Marca própria
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "brandName" TEXT;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "brandSubtitle" TEXT;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "brandColor" TEXT;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "brandLogo" TEXT;

-- Indicação (afiliados)
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "referralCode" TEXT;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "referredById" TEXT;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "referralRewardedAt" TIMESTAMP(3);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "referralRewardBrl" DOUBLE PRECISION;
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_referralCode_key" ON "accounts"("referralCode");

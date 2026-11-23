-- Cole tudo isto no SQL Editor do Supabase e clique em Run. Pode rodar mais de uma vez sem problema.
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

-- ===== Marca própria (white-label) =====
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "brandName" TEXT;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "brandSubtitle" TEXT;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "brandColor" TEXT;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "brandLogo" TEXT;

-- ===== Indicação (afiliados) =====
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "referralCode" TEXT;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "referredById" TEXT;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "referralRewardedAt" TIMESTAMP(3);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "referralRewardBrl" DOUBLE PRECISION;
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_referralCode_key" ON "accounts"("referralCode");

-- ===== Recarga automática de saldo =====
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "autoRechargeEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "autoRechargeThresholdBrl" DOUBLE PRECISION;
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "autoRechargeAmountBrl" DOUBLE PRECISION;
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "autoCardToken" TEXT;
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "autoCardBrand" TEXT;
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "autoCardLast4" TEXT;
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "autoRemoteIp" TEXT;
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "autoRechargeLastAt" TIMESTAMP(3);
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "autoRechargeFailedAt" TIMESTAMP(3);
ALTER TABLE "wallet_topups" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'manual';

-- ===== WhatsApp oficial gerenciado e revendedores =====
ALTER TABLE "whatsapp_connections" ADD COLUMN IF NOT EXISTS "managed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "whatsapp_connections" ADD COLUMN IF NOT EXISTS "priceBrl" DOUBLE PRECISION;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "isReseller" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "resellerId" TEXT;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "resellerMaxClients" INTEGER;
CREATE INDEX IF NOT EXISTS "accounts_resellerId_idx" ON "accounts"("resellerId");


-- ===== Emissor de NF-e (plano exclusivo) =====

CREATE TABLE IF NOT EXISTS "nfe_plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceCents" INTEGER NOT NULL,
    "cycleMonths" INTEGER NOT NULL DEFAULT 1,
    "maxMonthlyNotes" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "nfe_plans_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "nfe_subscriptions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "planId" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "billingCustomerId" TEXT,
    "billingSubscriptionId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "nfe_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "nfe_payments" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "paidAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "invoiceUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "nfe_payments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "nfe_subscriptions_accountId_key" ON "nfe_subscriptions"("accountId");
CREATE INDEX IF NOT EXISTS "nfe_subscriptions_billingSubscriptionId_idx" ON "nfe_subscriptions"("billingSubscriptionId");
CREATE INDEX IF NOT EXISTS "nfe_payments_accountId_createdAt_idx" ON "nfe_payments"("accountId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "nfe_subscriptions" ADD CONSTRAINT "nfe_subscriptions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "nfe_subscriptions" ADD CONSTRAINT "nfe_subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "nfe_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "nfe_payments" ADD CONSTRAINT "nfe_payments_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===== Vídeos tutoriais por página =====
CREATE TABLE IF NOT EXISTS "tutorial_videos" (
    "pageKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tutorial_videos_pkey" PRIMARY KEY ("pageKey")
);

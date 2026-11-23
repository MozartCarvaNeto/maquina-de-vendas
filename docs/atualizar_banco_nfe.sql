-- Emissor de NF-e (plano exclusivo). Rode no Supabase > SQL Editor.
-- (Alternativa: "bash deploy/atualizar-servidor.sh --banco" faz o mesmo sozinho.)

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

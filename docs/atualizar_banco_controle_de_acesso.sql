-- =====================================================================
-- Máquina de Vendas — atualização do banco: CONTROLE DE ACESSO / ASSINATURA
--
-- COMO USAR (sem terminal):
--   Supabase > SQL Editor > New query > cole TODO este arquivo > Run.
--   Pode rodar mais de uma vez: ele só cria o que ainda não existe.
--   Contas que já existem ficam "ativa" e sem vencimento (nada muda para elas).
--
-- (Opção B, pelo terminal: dentro da pasta backend rode "npx prisma db push")
-- =====================================================================

ALTER TABLE "accounts"
  ADD COLUMN IF NOT EXISTS "accessStatus"         TEXT NOT NULL DEFAULT 'ativa',
  ADD COLUMN IF NOT EXISTS "plan"                 TEXT,
  ADD COLUMN IF NOT EXISTS "subscriptionStartsAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "subscriptionEndsAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "blockedReason"        TEXT,
  ADD COLUMN IF NOT EXISTS "adminNotes"           TEXT;

CREATE TABLE IF NOT EXISTS "access_logs" (
  "id"        TEXT         NOT NULL,
  "accountId" TEXT         NOT NULL,
  "action"    TEXT         NOT NULL,
  "detail"    TEXT,
  "byEmail"   TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "access_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "access_logs_accountId_fkey" FOREIGN KEY ("accountId")
    REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "access_logs_accountId_createdAt_idx"
  ON "access_logs"("accountId", "createdAt");


-- =====================================================================
-- PARTE 2 (v2): PLANOS, LIMITES, COBRANÇA AUTOMÁTICA E USO MENSAL
-- Também pode rodar mais de uma vez.
-- =====================================================================

CREATE TABLE IF NOT EXISTS "plans" (
  "id"                     TEXT         NOT NULL,
  "name"                   TEXT         NOT NULL,
  "description"            TEXT,
  "priceCents"             INTEGER      NOT NULL,
  "cycleMonths"            INTEGER      NOT NULL DEFAULT 1,
  "maxWhatsappConnections" INTEGER,
  "maxMembers"             INTEGER,
  "maxMonthlyMessages"     INTEGER,
  "isActive"               BOOLEAN      NOT NULL DEFAULT true,
  "isPublic"               BOOLEAN      NOT NULL DEFAULT true,
  "sortOrder"              INTEGER      NOT NULL DEFAULT 0,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "accounts"
  ADD COLUMN IF NOT EXISTS "planId"                TEXT,
  ADD COLUMN IF NOT EXISTS "billingProvider"       TEXT,
  ADD COLUMN IF NOT EXISTS "billingCustomerId"     TEXT,
  ADD COLUMN IF NOT EXISTS "billingSubscriptionId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_planId_fkey') THEN
    ALTER TABLE "accounts"
      ADD CONSTRAINT "accounts_planId_fkey" FOREIGN KEY ("planId")
      REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "billing_payments" (
  "id"          TEXT         NOT NULL,
  "accountId"   TEXT         NOT NULL,
  "provider"    TEXT         NOT NULL DEFAULT 'asaas',
  "status"      TEXT         NOT NULL,
  "amountCents" INTEGER      NOT NULL,
  "dueDate"     TIMESTAMP(3),
  "paidAt"      TIMESTAMP(3),
  "appliedAt"   TIMESTAMP(3),
  "invoiceUrl"  TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_payments_accountId_fkey" FOREIGN KEY ("accountId")
    REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "billing_payments_accountId_createdAt_idx"
  ON "billing_payments"("accountId", "createdAt");

CREATE TABLE IF NOT EXISTS "usage_counters" (
  "id"        TEXT    NOT NULL,
  "accountId" TEXT    NOT NULL,
  "period"    TEXT    NOT NULL,
  "metric"    TEXT    NOT NULL,
  "value"     INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "usage_counters_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "usage_counters_accountId_fkey" FOREIGN KEY ("accountId")
    REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "usage_counters_accountId_period_metric_key"
  ON "usage_counters"("accountId", "period", "metric");

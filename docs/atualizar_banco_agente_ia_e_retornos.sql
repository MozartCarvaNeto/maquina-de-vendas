-- =====================================================================
-- Máquina de Vendas — atualização do banco
--   • Retorno agendado + clientes perdidos no CRM
--   • Agente de voz com IA (3º sistema de ligação)
--
-- COMO USAR (opção B — sem terminal):
--   Supabase > SQL Editor > New query > cole TODO este arquivo > Run.
--   Pode rodar mais de uma vez: ele só cria o que ainda não existe.
-- Depois rode "npx prisma generate" na pasta backend (o .bat já faz isso).
--
-- (Opção A: em vez deste arquivo, rode "npx prisma db push" na pasta backend.)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) CRM: retorno agendado e clientes perdidos
-- ---------------------------------------------------------------------
ALTER TABLE "crm_cards"
  ADD COLUMN IF NOT EXISTS "followUpAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "followUpNote"  TEXT,
  ADD COLUMN IF NOT EXISTS "lastContactAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lostAt"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lostReason"    TEXT;

CREATE INDEX IF NOT EXISTS "crm_cards_followUpAt_idx" ON "crm_cards"("followUpAt");

-- ---------------------------------------------------------------------
-- 2) Agente de voz IA: configuração do agente
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ai_voice_agents" (
  "id"                   TEXT         NOT NULL,
  "userId"               TEXT         NOT NULL,
  "name"                 TEXT         NOT NULL,
  "market"               TEXT         NOT NULL DEFAULT 'generico',
  "companyName"          TEXT         NOT NULL,
  "agentName"            TEXT         NOT NULL DEFAULT 'Júlia',
  "language"             TEXT         NOT NULL DEFAULT 'pt-BR',
  "voice"                TEXT         NOT NULL DEFAULT 'Polly.Camila-Neural',
  "objective"            TEXT         NOT NULL,
  "openingScript"        TEXT         NOT NULL,
  "extraInstructions"    TEXT,
  "handoffCriteria"      TEXT         NOT NULL,
  "glossary"             JSONB,
  "qualificationFields"  JSONB,
  "catalogText"          TEXT,
  "catalogUrl"           TEXT,
  "catalogWebText"       TEXT,
  "catalogFetchedAt"     TIMESTAMP(3),
  "handoffMode"          TEXT         NOT NULL DEFAULT 'whatsapp',
  "handoffPhone"         TEXT,
  "handoffAgentId"       TEXT,
  "notifySellerWhatsapp" BOOLEAN      NOT NULL DEFAULT true,
  "leadWhatsappMessage"  TEXT,
  "crmColumnId"          TEXT,
  "aiProvider"           TEXT,
  "maxTurns"             INTEGER      NOT NULL DEFAULT 14,
  "maxCallSeconds"       INTEGER      NOT NULL DEFAULT 420,
  "recordCalls"          BOOLEAN      NOT NULL DEFAULT false,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_voice_agents_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- 3) Agente de voz IA: campanhas
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ai_call_campaigns" (
  "id"                 TEXT         NOT NULL,
  "userId"             TEXT         NOT NULL,
  "name"               TEXT         NOT NULL,
  "agentId"            TEXT         NOT NULL,
  "audienceFilter"     JSONB        NOT NULL,
  "callerNumberId"     TEXT,
  "concurrency"        INTEGER      NOT NULL DEFAULT 1,
  "minDelaySeconds"    INTEGER      NOT NULL DEFAULT 20,
  "maxDelaySeconds"    INTEGER      NOT NULL DEFAULT 60,
  "windowStart"        TEXT         NOT NULL DEFAULT '09:00',
  "windowEnd"          TEXT         NOT NULL DEFAULT '18:00',
  "weekdaysOnly"       BOOLEAN      NOT NULL DEFAULT true,
  "status"             TEXT         NOT NULL DEFAULT 'rascunho',
  "isRunning"          BOOLEAN      NOT NULL DEFAULT false,
  "lastHeartbeatAt"    TIMESTAMP(3),
  "runningNote"        TEXT,
  "totalLeads"         INTEGER      NOT NULL DEFAULT 0,
  "calledCount"        INTEGER      NOT NULL DEFAULT 0,
  "answeredCount"      INTEGER      NOT NULL DEFAULT 0,
  "hotCount"           INTEGER      NOT NULL DEFAULT 0,
  "warmCount"          INTEGER      NOT NULL DEFAULT 0,
  "callbackCount"      INTEGER      NOT NULL DEFAULT 0,
  "handoffCount"       INTEGER      NOT NULL DEFAULT 0,
  "notInterestedCount" INTEGER      NOT NULL DEFAULT 0,
  "noAnswerCount"      INTEGER      NOT NULL DEFAULT 0,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_call_campaigns_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- 4) Ligações: vínculo com a campanha do agente IA
-- ---------------------------------------------------------------------
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "aiCallCampaignId" TEXT;

-- ---------------------------------------------------------------------
-- 5) Agente de voz IA: conversas (transcrição, resultado, passagem)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ai_call_sessions" (
  "id"             TEXT         NOT NULL,
  "userId"         TEXT         NOT NULL,
  "callId"         TEXT         NOT NULL,
  "campaignId"     TEXT,
  "agentId"        TEXT,
  "leadId"         TEXT         NOT NULL,
  "isTest"         BOOLEAN      NOT NULL DEFAULT false,
  "transcript"     JSONB,
  "collected"      JSONB,
  "summary"        TEXT,
  "outcome"        TEXT,
  "turnCount"      INTEGER      NOT NULL DEFAULT 0,
  "silenceCount"   INTEGER      NOT NULL DEFAULT 0,
  "effectsApplied" BOOLEAN      NOT NULL DEFAULT false,
  "handoffStatus"  TEXT,
  "handoffAt"      TIMESTAMP(3),
  "handoffTarget"  TEXT,
  "callbackAt"     TIMESTAMP(3),
  "callbackNote"   TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_call_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ai_call_sessions_callId_key"    ON "ai_call_sessions"("callId");
CREATE INDEX        IF NOT EXISTS "ai_call_sessions_campaignId_idx" ON "ai_call_sessions"("campaignId");

-- ---------------------------------------------------------------------
-- 6) Chaves estrangeiras (cada bloco ignora se já existir)
-- ---------------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE "ai_voice_agents" ADD CONSTRAINT "ai_voice_agents_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_call_campaigns" ADD CONSTRAINT "ai_call_campaigns_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_call_campaigns" ADD CONSTRAINT "ai_call_campaigns_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "ai_voice_agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "calls" ADD CONSTRAINT "calls_aiCallCampaignId_fkey"
    FOREIGN KEY ("aiCallCampaignId") REFERENCES "ai_call_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_call_sessions" ADD CONSTRAINT "ai_call_sessions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_call_sessions" ADD CONSTRAINT "ai_call_sessions_callId_fkey"
    FOREIGN KEY ("callId") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_call_sessions" ADD CONSTRAINT "ai_call_sessions_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "ai_call_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Turbo Prospect - Telefone SIP no navegador (ramais e histórico de chamadas).
-- Seguro para rodar mais de uma vez. Rode no SQL Editor do Supabase (depois do script do gateway).
CREATE TABLE IF NOT EXISTS "sip_extensions" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "memberId" TEXT NOT NULL, "extension" TEXT NOT NULL,
  "passwordEnc" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "sip_extensions_memberId_key" ON "sip_extensions"("memberId");
CREATE UNIQUE INDEX IF NOT EXISTS "sip_extensions_userId_extension_key" ON "sip_extensions"("userId", "extension");

CREATE TABLE IF NOT EXISTS "sip_call_logs" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "memberId" TEXT NOT NULL, "direction" TEXT NOT NULL, "number" TEXT NOT NULL,
  "contactName" TEXT, "status" TEXT NOT NULL, "startedAt" TIMESTAMP(3) NOT NULL, "answeredAt" TIMESTAMP(3), "endedAt" TIMESTAMP(3),
  "durationSec" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "sip_call_logs_userId_startedAt_idx" ON "sip_call_logs"("userId", "startedAt");

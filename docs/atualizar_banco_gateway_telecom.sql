-- Turbo Prospect - Gateway de telecom nativo (SMS por SMPP, API própria, troncos SIP).
-- Seguro para rodar mais de uma vez. Rode no SQL Editor do Supabase.
CREATE TABLE IF NOT EXISTS "sms_carriers" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "name" TEXT NOT NULL, "protocol" TEXT NOT NULL DEFAULT 'smpp',
  "host" TEXT NOT NULL, "port" INTEGER NOT NULL DEFAULT 2775, "useTls" BOOLEAN NOT NULL DEFAULT false,
  "systemId" TEXT NOT NULL, "passwordEnc" TEXT NOT NULL, "systemType" TEXT, "defaultSender" TEXT,
  "tps" DOUBLE PRECISION NOT NULL DEFAULT 10, "windowSize" INTEGER NOT NULL DEFAULT 10, "priority" INTEGER NOT NULL DEFAULT 1,
  "costPerPart" DOUBLE PRECISION NOT NULL DEFAULT 0, "normalize" TEXT NOT NULL DEFAULT 'keep', "concatMode" TEXT NOT NULL DEFAULT 'udh',
  "allowedPrefixes" TEXT, "enabled" BOOLEAN NOT NULL DEFAULT true, "lastStatus" TEXT, "lastError" TEXT, "lastBoundAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "sms_carriers_userId_idx" ON "sms_carriers"("userId");

CREATE TABLE IF NOT EXISTS "sms_messages" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "carrierId" TEXT, "direction" TEXT NOT NULL DEFAULT 'out',
  "fromAddr" TEXT NOT NULL, "toAddr" TEXT NOT NULL, "body" TEXT NOT NULL, "encoding" TEXT, "parts" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'queued', "providerIds" TEXT, "partsDelivered" INTEGER NOT NULL DEFAULT 0,
  "errorCode" TEXT, "errorMessage" TEXT, "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "costBrl" DOUBLE PRECISION NOT NULL DEFAULT 0, "priceBrl" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "source" TEXT NOT NULL DEFAULT 'app', "apiKeyId" TEXT, "clientRef" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "sentAt" TIMESTAMP(3), "deliveredAt" TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS "sms_messages_userId_createdAt_idx" ON "sms_messages"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "sms_messages_status_nextAttemptAt_idx" ON "sms_messages"("status", "nextAttemptAt");

CREATE TABLE IF NOT EXISTS "sms_api_keys" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "name" TEXT NOT NULL, "prefix" TEXT NOT NULL, "keyHash" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true, "lastUsedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "sms_api_keys_keyHash_key" ON "sms_api_keys"("keyHash");
CREATE INDEX IF NOT EXISTS "sms_api_keys_userId_idx" ON "sms_api_keys"("userId");

CREATE TABLE IF NOT EXISTS "sip_trunks" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "name" TEXT NOT NULL, "host" TEXT NOT NULL, "port" INTEGER NOT NULL DEFAULT 5060,
  "transport" TEXT NOT NULL DEFAULT 'udp', "username" TEXT, "passwordEnc" TEXT, "register" BOOLEAN NOT NULL DEFAULT true,
  "fromDomain" TEXT, "outboundCallerId" TEXT, "dialPrefix" TEXT, "codecs" TEXT NOT NULL DEFAULT 'alaw,ulaw',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "sip_trunks_userId_idx" ON "sip_trunks"("userId");

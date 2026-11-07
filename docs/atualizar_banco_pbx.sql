-- PBX nativo (URA, filas, rotas de entrada, gravação). Cole no SQL Editor do Supabase e clique em RUN.
CREATE TABLE IF NOT EXISTS "pbx_audios" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "name" TEXT NOT NULL, "kind" TEXT NOT NULL DEFAULT 'prompt',
  "durationMs" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "pbx_audios_userId_idx" ON "pbx_audios"("userId");

CREATE TABLE IF NOT EXISTS "pbx_ivrs" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "name" TEXT NOT NULL, "greetingAudioId" TEXT, "invalidAudioId" TEXT,
  "timeoutSeconds" INTEGER NOT NULL DEFAULT 6, "maxRetries" INTEGER NOT NULL DEFAULT 2, "options" JSONB NOT NULL DEFAULT '[]',
  "timeoutDest" JSONB, "extensionDial" BOOLEAN NOT NULL DEFAULT false, "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "pbx_ivrs_userId_idx" ON "pbx_ivrs"("userId");

CREATE TABLE IF NOT EXISTS "pbx_queues" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "name" TEXT NOT NULL, "strategy" TEXT NOT NULL DEFAULT 'rrmemory',
  "ringSeconds" INTEGER NOT NULL DEFAULT 20, "maxWaitSeconds" INTEGER NOT NULL DEFAULT 300, "wrapupSeconds" INTEGER NOT NULL DEFAULT 5,
  "mohAudioId" TEXT, "announceHoldtime" BOOLEAN NOT NULL DEFAULT false, "joinEmpty" BOOLEAN NOT NULL DEFAULT false,
  "members" JSONB NOT NULL DEFAULT '[]', "overflowDest" JSONB, "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "pbx_queues_userId_idx" ON "pbx_queues"("userId");

CREATE TABLE IF NOT EXISTS "pbx_inbound_routes" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "name" TEXT NOT NULL, "trunkId" TEXT, "did" TEXT, "dest" JSONB NOT NULL,
  "hours" JSONB, "closedDest" JSONB, "record" BOOLEAN NOT NULL DEFAULT true, "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "pbx_inbound_routes_userId_idx" ON "pbx_inbound_routes"("userId");

CREATE TABLE IF NOT EXISTS "pbx_calls" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "uniqueId" TEXT NOT NULL, "direction" TEXT NOT NULL,
  "fromNumber" TEXT, "toNumber" TEXT, "trunk" TEXT, "routeId" TEXT, "queueName" TEXT, "extension" TEXT, "memberId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'tocando', "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "answeredAt" TIMESTAMP(3), "endedAt" TIMESTAMP(3), "durationSeconds" INTEGER, "recordingFile" TEXT, "voicemailFile" TEXT,
  "hangupCause" TEXT, "aiCallId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "pbx_calls_userId_uniqueId_key" ON "pbx_calls"("userId","uniqueId");
CREATE INDEX IF NOT EXISTS "pbx_calls_userId_startedAt_idx" ON "pbx_calls"("userId","startedAt");

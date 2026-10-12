-- Turbo Prospect - suporte a fotos/documentos/áudios/vídeos no Chat.
-- Seguro para rodar mais de uma vez.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "mediaType" TEXT;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "mediaPath" TEXT;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "mediaMime" TEXT;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "mediaName" TEXT;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "mediaSize" INTEGER;

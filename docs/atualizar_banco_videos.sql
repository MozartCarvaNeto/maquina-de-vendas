-- Vídeos tutoriais por página. Rode no Supabase > SQL Editor.
-- (Alternativa: "bash deploy/atualizar-servidor.sh --banco" faz o mesmo sozinho.)
CREATE TABLE IF NOT EXISTS "tutorial_videos" (
    "pageKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tutorial_videos_pkey" PRIMARY KEY ("pageKey")
);

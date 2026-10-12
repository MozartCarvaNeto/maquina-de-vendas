-- =====================================================================
-- Configurações: garantias no banco (Supabase > SQL Editor > Run)
-- É SEGURO rodar mais de uma vez. Não altera o schema do Prisma
-- (não precisa de "prisma generate" por causa deste arquivo).
-- =====================================================================

-- 1) Remove linhas duplicadas da mesma chave (mantém a mais recente).
--    Só faz algo se o índice único do passo 2 ainda não existia.
DELETE FROM settings s
USING settings d
WHERE s."userId"   = d."userId"
  AND s."category" = d."category"
  AND s."provider" = d."provider"
  AND s."key"      = d."key"
  AND s."id" <> d."id"
  AND (s."updatedAt" < d."updatedAt"
       OR (s."updatedAt" = d."updatedAt" AND s."id" < d."id"));

-- 2) Garante o índice único que o salvamento (upsert) usa.
CREATE UNIQUE INDEX IF NOT EXISTS "settings_userId_category_provider_key_key"
  ON "settings"("userId", "category", "provider", "key");

-- 3) Reativa chaves de IA e de Busca de empresas que tenham ficado desativadas
--    (esses dois tipos nunca deveriam ficar inativos).
UPDATE settings
SET "isActive" = true
WHERE "category" IN ('ai', 'leadsearch')
  AND "isActive" = false;

-- 4) DIAGNÓSTICO: o que está salvo por conta (os valores ficam criptografados; aqui só aparece o resumo).
SELECT a."name"            AS conta,
       s."category"        AS tipo,
       s."provider"        AS provedor,
       count(*)            AS campos,
       bool_and(s."isActive") AS ativo,
       max(s."updatedAt")  AS atualizado_em
FROM settings s
JOIN accounts a ON a."id" = s."userId"
GROUP BY a."name", s."category", s."provider"
ORDER BY a."name", s."category", s."provider";

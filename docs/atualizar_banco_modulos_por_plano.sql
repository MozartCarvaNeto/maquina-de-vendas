-- Turbo Prospect (Máquina de Vendas) — módulos (funcionalidades) por plano
-- Rode UMA vez no Supabase: SQL Editor > New query > cole tudo > Run.
-- Pode rodar de novo sem problema (não duplica nada).
--
-- Coluna vazia (NULL) = o plano libera TODAS as funcionalidades.
-- Por isso os planos que você já criou continuam completos até você editá-los.
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "features" JSONB;

-- =====================================================================
-- Diagnóstico das ligações do Agente de IA (Supabase > SQL Editor).
-- SÓ LEITURA: não altera nada. Não é obrigatório para aplicar a atualização.
-- =====================================================================

-- 1) Quais avisos de status a Twilio mandou nas últimas ligações de IA?
--    Antes da correção você só verá: initiated / ringing / completed (NUNCA "in-progress"/"answered"),
--    por isso o sistema achava que ninguém atendeu. Depois da correção aparece também "in-progress".
SELECT c."id", c."status", c."answeredAt", e."eventType", e."createdAt"
FROM calls c
JOIN call_events e ON e."callId" = c."id"
WHERE c."answeredBy" = 'ia'
ORDER BY c."startedAt" DESC, e."createdAt"
LIMIT 60;

-- 2) Ligações em que houve conversa mas o resultado ficou "sem resposta" ou nunca foi aplicado no CRM.
SELECT s."id", s."isTest", s."turnCount", s."outcome", s."effectsApplied", s."createdAt"
FROM ai_call_sessions s
WHERE s."turnCount" > 0
  AND (s."effectsApplied" = false OR s."outcome" IS NULL OR s."outcome" = 'sem_resposta')
ORDER BY s."createdAt" DESC
LIMIT 30;

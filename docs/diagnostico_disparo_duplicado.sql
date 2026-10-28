-- Turbo Prospect - Diagnóstico de disparo com mensagem repetida.
-- Só LEITURA (SELECT): pode rodar à vontade no Supabase > SQL Editor.

-- 1) Mesmo telefone cadastrado mais de uma vez como lead (causa de mensagem repetida).
SELECT "userId", right(regexp_replace(phone, '\D', '', 'g'), 11) AS telefone, count(*) AS vezes
FROM leads
WHERE phone IS NOT NULL AND phone <> ''
GROUP BY 1, 2
HAVING count(*) > 1
ORDER BY vezes DESC
LIMIT 50;

-- 2) Quantas mensagens de SAÍDA cada lead recebeu nas últimas 48 horas (mais de 1 = repetição).
SELECT l.name, l.phone, count(*) AS mensagens, min(m."createdAt") AS primeira, max(m."createdAt") AS ultima
FROM messages m
JOIN leads l ON l.id = m."leadId"
WHERE m.direction = 'saida' AND m.channel = 'whatsapp' AND m."createdAt" > now() - interval '48 hours'
GROUP BY l.id, l.name, l.phone
HAVING count(*) > 1
ORDER BY mensagens DESC
LIMIT 100;

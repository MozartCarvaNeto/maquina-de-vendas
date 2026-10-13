# Correção: resultado da ligação da IA (teste e campanha) não chegava ao CRM

## Causa encontrada
A Twilio só avisa que a pessoa ATENDEU se o sistema pedir o evento `answered` (o status chega como
`in-progress`). O sistema pedia nomes que a Twilio não aceita (`in-progress`, `queued`, `busy`...) e não pedia
`answered`. Resultado: a ligação nunca era marcada como atendida, o fechamento tratava tudo como "sem resposta"
e **pulava** o CRM, o relatório e a mensagem ao cliente. Valia para o teste e para campanhas reais.
Além disso, ligações de teste eram propositalmente ignoradas nesse passo.

## O que mudou
1. `TwilioProvider.js`: pede os eventos válidos (`initiated, ringing, answered, completed`).
2. `aiCallService.js`:
   - "Atendida" agora também vale quando já houve conversa (não depende só do aviso da Twilio);
   - o resultado é aplicado assim que a IA se despede, sem esperar o aviso de ligação encerrada;
   - **teste e campanha real seguem o mesmo fluxo**: lead quente/morno/retorno agendado entra no CRM com o
     relatório na anotação, o contato guarda o canal preferido, o cliente recebe o WhatsApp de continuidade
     (quem prefere ligação não recebe) e o consultor recebe o relatório por WhatsApp;
   - cliente que prefere LIGAÇÃO entra na fila do discador (somente em campanha real);
   - se a conta ainda não tem quadro de CRM, o padrão é criado automaticamente;
   - o relatório diz exatamente o que foi feito (coluna do CRM, WhatsApp enviado, fila) ou por que não entrou.
3. `aiVoiceEngine.js`: a IA pergunta ao cliente interessado se prefere continuar por WhatsApp ou ligação e
   registra o canal (`canal_preferido`). Se escolher WhatsApp, a IA se despede e o consultor chama por lá;
   se escolher ligação, segue a passagem normal.
4. Ligações > Agente de IA > "Últimos testes": mostra em qual coluna do CRM o contato de teste caiu.

## Como aplicar
Copie `backend`, `frontend` e `docs` por cima do projeto, `npm run build` no frontend e reinicie o backend.
**Não há SQL obrigatório nem mudança de schema.** (`docs/diagnostico_ligacoes_ia.sql` é só leitura, opcional.)

## Como testar
1. Ligações > Agente de IA > faça uma ligação de teste, demonstre interesse e diga que prefere WhatsApp.
2. Em até alguns segundos após a despedida: o contato "Teste IA — seu número" aparece no CRM
   (coluna Qualificado/Em Qualificação, marcado 🧪 TESTE), o relatório aparece em Conversas como nota interna,
   você recebe o relatório por WhatsApp e o "celular do cliente" (o seu) recebe a mensagem de continuidade.
3. Repita pedindo LIGAÇÃO: nenhum WhatsApp ao cliente e o relatório indica "ligue para ele".
4. Se algo não aparecer, rode `docs/diagnostico_ligacoes_ia.sql` e me envie o resultado do item 1.

> O contato e o card de teste ficam no seu CRM de verdade: apague-os quando terminar os testes.

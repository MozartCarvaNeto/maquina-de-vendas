# Atualização: e-mail pela Twilio SendGrid, pronúncia da IA e relatório da ligação

Este pacote é cumulativo (inclui também a correção de Configurações enviada antes). Copie as pastas
`backend`, `frontend` e `docs` por cima do projeto. **Não há SQL novo nem mudança de schema**
(a nota do relatório usa as colunas que já existem em `messages`).
Depois: `npm run build` no frontend e reinicie o backend.

## 1) E-mail pela Twilio (SendGrid) — Configurações > E-mail > "Twilio SendGrid"
- O e-mail da Twilio é o SendGrid e usa chave própria. O Account SID / Auth Token da Twilio NÃO envia e-mail.
- No SendGrid: Settings > API Keys > crie uma chave com Mail Send e copie o valor `SG.…`.
- Settings > Sender Authentication: verifique o e-mail remetente (ou o domínio). O remetente digitado no
  sistema precisa ser exatamente o verificado, senão o SendGrid recusa o envio.
- SMTP, Resend e E-mail Nativo continuam funcionando; só se usa um por vez (o último salvo fica ativo).

## 2) Pronúncia ("Piercing Express")
- A voz em português lia "Piercing Express" como se fosse português. Agora, só na hora de falar, palavras em
  inglês comuns em nomes de empresa são trocadas por uma grafia falada (Piercing → "Pírsin", Express → "Ispréss").
  O texto salvo e as mensagens de WhatsApp continuam com o nome original.
- Para ajustar qualquer termo (ou o nome inteiro da empresa): Agente IA > editar agente > Treinamento do
  mercado > nova coluna "Como falar". Ex.: termo `Piercing Express`, como falar `Pírsin Ispréss`.
  O que você escrever ali tem prioridade sobre o dicionário padrão. Faça ligações de teste e vá refinando.
- A naturalidade da voz depende do motor (Polly Neural). Dá para testar outras vozes no editor do agente.

## 3) Relatório da ligação para continuar o atendimento
- Ao fim de cada ligação com conversa, a IA gera um relatório: resultado, resumo, informações coletadas,
  retorno combinado, situação da passagem ao consultor, conversa resumida e próximo passo.
- Aparece em Conversas, no histórico do contato, como "Nota interna" (não é enviada ao cliente) e vai por
  WhatsApp para o consultor (leads quente/morno/retorno, se "avisar vendedor por WhatsApp" estiver ligado).
- Ligação de TESTE agora também gera o relatório: vai para o consultor cadastrado ou, se não houver,
  para o próprio número de teste, sem mexer no CRM nem escrever ao cliente.
- Notas internas não entram no histórico que o robô de WhatsApp lê nem atrapalham o follow-up automático.

## 4) "[Anexo recebido, mas não foi possível baixar]"
- Essa mensagem é uma mensagem RECEBIDA do contato (um áudio/foto/arquivo) que o servidor não conseguiu
  salvar; não era o retorno da IA. O retorno da IA não aparecia porque ligações de teste não geravam nada.
- O download agora tenta até 3 vezes (o WhatsApp Web às vezes ainda não liberou o arquivo na 1ª tentativa),
  buscando a mensagem de novo entre as tentativas.
- Se ainda falhar, o chat diz o tipo ("Áudio recebido, mas não foi possível baixar…") e o log do servidor
  registra o motivo real: procure por "Anexo (…) não baixado:". Me envie essa linha se continuar acontecendo.

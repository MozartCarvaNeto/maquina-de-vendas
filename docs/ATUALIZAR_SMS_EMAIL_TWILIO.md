# Atualização: disparos de SMS e E-mail pela Twilio

## O que estava errado
Os 157 SMS falharam porque: (1) os telefones não eram convertidos para o formato internacional (+55…); (2) não havia um remetente de SMS válido (o número das ligações costuma não ter SMS); (3) o erro da Twilio aparecia cru. Agora o sistema normaliza o número, usa o remetente que você configurar, traduz o erro e **pausa o disparo** (em vez de falhar tudo) quando o problema é de configuração.

## 1. Instalar
1. Copie as pastas `backend` e `frontend` deste zip por cima do projeto (substituindo os arquivos).
2. Reinicie o backend e gere o frontend de novo (`npm run build` no frontend), como nas atualizações anteriores. Não há SQL nem migração.

## 2. Chaves só para administradores (opcional, no `.env` do backend)
```
TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxx
TWILIO_SMS_FROM=+1XXXXXXXXXX      # número com SMS, ou MGxxxx (Messaging Service)
TWILIO_EMAIL_FROM=voce@seudominio.com   # remetente verificado na Twilio
```
Essas chaves do `.env` valem **somente para a conta do administrador da plataforma** (e-mail em `SUPER_ADMIN_EMAILS`). Os demais clientes precisam colocar as próprias chaves em Configurações.
Se preferir, não use o `.env`: entre como administrador e preencha em **Configurações** (Telefonia → SMS → E-mail).

## 3. Na Twilio (console.twilio.com)
**SMS**
- Precisa de um número que envie SMS (Phone Numbers → Buy a number, marque SMS) ou um Messaging Service.
- Messaging → Settings → **Geo permissions** → habilite **Brazil**.
- Conta Trial: só envia para números verificados (Phone Numbers → Verified Caller IDs). Para disparar para clientes, faça upgrade.
- Operadoras brasileiras podem bloquear SMS vindo de número estrangeiro; se isso ocorrer, o erro aparecerá traduzido na aba Falhas.

**E-mail**
- Console → Email: verifique o remetente (Sender) ou autentique o domínio. Sem isso a Twilio recusa o envio.
- Esse envio não aceita anexos (para anexo use SMTP/Resend/SendGrid).

## 4. Configurar no sistema
1. Configurações → **Telefonia**: Account SID e Auth Token (já feito para as ligações).
2. Configurações → **SMS (Twilio)**: informe o remetente e use **Enviar SMS de teste**.
3. Configurações → **E-mail**: escolha **Twilio E-mail**, informe o remetente verificado e use **Enviar e-mail de teste**.
4. Só dispare depois que os dois testes chegarem.

## 5. Os 157 que falharam
Eles continuam marcados como falha. Crie um novo disparo com a mesma lista (ou use Retomar, se ele estiver pausado).

## 6. WhatsApp
Os disparos pelo WhatsApp Web continuam como estão. A API de WhatsApp da Twilio não foi ligada: no plano grátis é só sandbox (o destinatário precisa entrar no sandbox) e, em produção, exige número aprovado pela Meta e modelos de mensagem.

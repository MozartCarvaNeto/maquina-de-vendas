# Atualização: saldo pré-pago, SMS completo, IA recebendo ligações, painel ao vivo

Esta atualização vem **junto** das anteriores (PBX nativo e vozes). Aplique tudo em ordem se ainda não aplicou.

## 1. Passos obrigatórios
1. Copie os arquivos do zip por cima do projeto.
2. No banco, rode o arquivo `docs/atualizar_banco_pbx_avancado.sql` (cria as tabelas de saldo e as colunas novas).
3. No `backend`, rode `npx prisma generate` e reinicie o sistema.
4. Em **Telefonia PBX → Configurações → Aplicar no Asterisk** (gera o novo trecho do plano de discagem).

## 2. O que mudou (como usar)
**Saldo pré-pago** (Gateway → aba 💳 Saldo)
- Só o administrador da plataforma recarrega o saldo e define tarifas (SMS por parte, ligação feita/recebida por minuto, cobrança a cada 1/6/30/60 s) em cada conta.
- Com o pré-pago **ligado** na conta, SMS e ligações são bloqueados sem saldo. Desligado = funciona como antes (sem limite).
- SMS é cobrado ao entrar na fila e **estornado** se falhar ou for cancelado. Ligação é cobrada quando termina; antes de discar o sistema confere o saldo e limita a duração ao que o saldo cobre.

**SMS** (Gateway → ✉️ Enviar, 💬 Conversas, 🔑 API)
- Agendar envio (campo "Agendar para"; até 30 dias) e cancelar agendado (estorna).
- Conversas: respostas dos clientes aparecem e você responde da própria tela.
- API: `sendAt`, `callbackUrl`, `DELETE /messages/:id`, `GET /balance`; webhook por chave com assinatura `X-Turbo-Signature` (HMAC-SHA256). Eventos `sms.status` e `sms.received`.

**IA atendendo ligações recebidas**
- Telefonia PBX → Configurações: escolha o **agente** e a saudação. Em Rotas de entrada (ou opção de URA) escolha o destino **Atendente de IA**.
- Quem liga vira lead (ou é reconhecido pelo telefone) e a conversa fica registrada; a IA sabe que foi a pessoa que ligou. Para passar a um humano usa a mesma fila de transferência das ligações da IA.

**Painel ao vivo** (Telefonia PBX → 🔴 Ao vivo)
- Chamadas em andamento e filas (esperando, atendentes), atualizado a cada 4 s.
- Supervisor: Escutar, Sussurrar (só o vendedor ouve), Entrar na chamada, Derrubar. O ramal do supervisor toca; deixe a tela **Telefone SIP** aberta e atenda.

**Transferência** no telefone do navegador: botão ↪️ Transferir (ramal ou número), às cegas.

## 3. Limites honestos
- Nada disso foi testado contra um Asterisk, operadora SMPP/SIP ou APIs de voz reais — só com simuladores. Faça um teste de cada recurso antes de usar com clientes.
- Tentativas do webhook de SMS ficam na memória (se reiniciar o sistema no meio, as pendentes se perdem).
- A cobrança de voz acontece no fim da chamada: o saldo pode ficar levemente negativo; o limite de duração reduz isso.
- O painel ao vivo lê a saída de texto do Asterisk; versões muito diferentes podem exigir ajuste.
- RCS segue por integração com fornecedor (não é nativo). Amazon Transcribe não foi incluído de propósito.

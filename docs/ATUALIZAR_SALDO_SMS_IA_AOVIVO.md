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

---

# Complemento: RCS direto pelo Google e discador pelo Asterisk

## RCS direto (Google RBM)
- Configurações → RCS → escolha **"Google RCS direto"**, cole o JSON da conta de serviço do seu agente RBM (e, se tiver mais de um agente, o ID dele).
- O sistema fala direto com a API do Google (texto, cartão com imagem, botões de link/ligar e respostas rápidas). Se o celular não tem RCS, usa o SMS de segurança dos Disparos (nativo, se você ativou).
- **Não dá para dispensar o Google:** o agente precisa ser criado e **aprovado** (verificação da marca, e liberação por operadora) no Google RBM Console ou por um parceiro. Sem isso o Google recusa o envio. Respostas dos clientes ao RCS (recebimento) ainda não estão ligadas.

## Discador manual e automático pelo Asterisk
- Configurações → "Telefonia do discador (vendedores)" → **Asterisk**. Depois clique em **Aplicar no Asterisk** (novos trechos no plano de discagem).
- Fluxo: o Asterisk liga ao cliente pelo seu tronco SIP; quando atende, o sistema chama o vendedor — no telefone do navegador (tela Telefone SIP aberta) ou, se ela estiver fechada, no celular dele pelo tronco — e junta os dois numa sala. Fila automática, pausa por vendedor, tentativas e histórico funcionam como antes.
- Ligações da IA e discador agora têm escolhas independentes (cada um pode ficar na Twilio ou no Asterisk).
- Saldo pré-pago: a perna do cliente é cobrada; o limite de duração segue o saldo.

## Limites
- **URA reversa (robô com áudios) continua na Twilio** (usa arquivos de áudio e teclas; precisa de uma etapa própria).
- **Gravação do discador pelo Asterisk ainda não foi ligada** (a opção "gravar" só vale na Twilio; as gravações do PBX e da IA continuam).
- Não testado com Asterisk real: em especial a passagem de variáveis entre as duas metades do canal "Local" — se a ligação não sair, envie o log do Asterisk.

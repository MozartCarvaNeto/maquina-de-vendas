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

## URA reversa e gravação pelo Asterisk (nova)
- Com o discador em **Asterisk**, a **URA reversa** (robô com áudios) também liga pelo Asterisk: toca o áudio de abertura, lê a tecla; se ninguém apertar e a campanha usa "reconhecer fala", o sistema escuta ~6 s. A decisão (interessado / sem interesse / opt-out / WhatsApp / CRM) é a mesma da versão Twilio. Os áudios de resposta (WAV ou MP3) são tocados; sem áudio, o sistema fala com a voz configurada.
- **MP3 precisa do ffmpeg no servidor** (`apt install ffmpeg`; a imagem Docker já traz). WAV funciona sem ele.
- **Gravação:** a opção "gravar chamadas" do discador e da URA reversa agora grava pelo Asterisk (conversa inteira) e o áudio toca no histórico de ligações, como antes.
- Observação: a tecla é lida durante o áudio de abertura (interrompe o áudio); a fala só é escutada depois dele terminar.

## Limites
- Não testado com Asterisk real: em especial a passagem de variáveis entre as duas metades do canal "Local", o `mixmonitor start` pelo console e a leitura de tecla (`Read`) — se algo não funcionar, envie o log do Asterisk.
- Ligações com roteiro TwiML de outros tipos continuam só na Twilio (não há outras além das já cobertas).

---

# Complemento: infraestrutura só do administrador (venda de créditos)

**Só o administrador da plataforma** (e-mail em `SUPERADMIN_EMAILS`) pode:
- cadastrar/editar/apagar **troncos SIP** e **fornecedores SMPP** (e ver a tela de fornecedores e de Voz SIP);
- ver a configuração do Asterisk dos troncos e baixar arquivos com senhas;
- cadastrar as **chaves dos motores de voz** (Google, Azure, Amazon, ElevenLabs, OpenAI) e fazer os testes de voz;
- recarregar saldo e definir tarifas (já era assim).

**O cliente (dono/admin da conta)** continua podendo: enviar SMS, ver conversas e saldo, criar filas, URA, rotas e áudios, escolher agente de IA, usar o discador e o telefone do navegador, criar chaves de API. Ele **não vê o custo** do SMS (só o que gastou), nem o fornecedor usado, nem os dados do tronco.

**Como o cliente liga sem ter tronco:** se a conta dele não tem tronco/fornecedor próprio, o sistema usa automaticamente os da conta do administrador (SMS, discador, IA, URA reversa). Idem para as chaves de voz. A cobrança é pelo saldo/tarifa de cada conta.

## Números de entrada (DID) por cliente — NOVO
- **Passos:** rode o SQL novo (`docs/atualizar_banco_pbx_avancado.sql`, tabela `pbx_dids`), `npx prisma generate`, reinicie.
- **Telefonia PBX → aba "📞 Números (admin)"** (só você): 1) cadastre os números que contratou no tronco; 2) atribua a um cliente (marcando vários) ou cole uma lista `número;e-mail do cliente` para atribuir vários a vários; 3) ligue a **atribuição automática**: o cliente com telefonia no plano e sem número recebe um do estoque na primeira vez que abrir a Telefonia PBX.
- Ao atribuir, o sistema grava a configuração no Asterisk sozinho (se o Asterisk estiver neste servidor) e o número aparece para o cliente: na lista de números das rotas de entrada e em Linhas (número de discagem usado pelo discador, robô e IA).
- A ligação que entra no número cai na conta do cliente: rota, URA, fila, IA, gravação, saldo (ligação recebida cobrada pela tarifa dele).
- O cliente só consegue criar rota para números dele.
- **Padrão nativo:** cliente sem chaves de outra operadora (Twilio etc.) passa a ligar pelo serviço nativo automaticamente: discador automático, URA reversa (robô), Agente IA. O "Vendedor Humano" não usa operadora (o vendedor liga do próprio telefone).
- Limites: não existe cobrança de mensalidade do número (só os minutos/SMS por saldo); a atribuição automática só roda quando o cliente abre a Telefonia PBX; se o Asterisk não estiver no mesmo servidor, clique "Aplicar no Asterisk" na sua conta e na do cliente.


---

## Atualização: mensalidade dos números, atribuição automática, Asterisk em outro servidor

Tudo abaixo é feito **só pelo administrador** (conta em `SUPERADMIN_EMAILS`), em **Telefonia PBX**.

### Passos para atualizar
1. Rode no banco o trecho novo no fim de `docs/atualizar_banco_pbx_avancado.sql` (5 colunas novas em `pbx_dids`; pode rodar de novo sem problema).
2. No backend: `npx prisma generate` e reinicie o servidor. No frontend: gere a build de novo.
3. Abra **Telefonia PBX → 📞 Números (admin)** e **🖥️ Servidor Asterisk (admin)**.

### 1. Mensalidade do número (aba Números)
- Ligue "Cobrar mensalidade dos números", defina a **mensalidade padrão** e os **dias de carência**.
- Cada número pode ter **mensalidade própria** (botão Editar; vazio = padrão, 0 = grátis).
- A cobrança roda sozinha **de hora em hora** e debita do saldo do cliente (aparece no extrato como "Mensalidade do número"). O 1º mês é cobrado logo após atribuir. Clientes **sem carteira ligada** não são cobrados.
- Sem saldo: entra em "⚠️ sem saldo"; passando a carência o número é **suspenso** (a ligação deixa de entrar na conta do cliente). Quando o cliente recarrega (você ou o pagamento), o sistema cobra e **reativa sozinho**.
- Botões por número: **Editar** (dígitos, observação, mensalidade), **Suspender/Reativar**, **Cobranças** (histórico), **Apagar**. Para **transferir** para outro cliente, marque o número e use "Atribuir" com outro cliente. "Rodar cobrança agora" força a rotina.
- O cliente vê o aviso de suspensão/atraso na aba Rotas.

### 2. Atribuição automática (sem o cliente abrir nada)
- Agora é uma rotina de segundo plano (a cada 10 min e ao iniciar o servidor): todo cliente **ativo**, com telefonia no plano e **sem número** recebe o próximo do estoque. "Rodar atribuição agora" força.

### 3. Asterisk em outro servidor (aba Servidor Asterisk)
- Escolha "Em outro servidor (SSH)", informe IP, porta, usuário e cole a **chave privada**; ela fica criptografada e nunca volta para a tela. Clique **Testar conexão** (SSH, Asterisk e pastas) e **Aplicar configuração em todas as contas**.
- Passa a funcionar por SSH: configuração, áudios, ligações (discador, robô, IA, click-to-call, supervisão), comandos e a escuta das gravações.
- No servidor do Asterisk: usuário com permissão de rodar `asterisk -rx` e de gravar nas pastas (conf, outgoing, sounds, gravações). 
- Preencha "Endereço de retorno" (`http://IP-DO-SISTEMA:PORTA/api/pbx-hook`) e o IP do sistema para a ponte da IA. A porta do AudioSocket (padrão 4574) **não tem senha**: o sistema só aceita o IP do Asterisk, mas **libere no firewall só esse IP**.
- Depois de trocar entre "este servidor" e "outro servidor", **reinicie o backend** uma vez.
- Limites: não testado contra um Asterisk real; arquivos de áudio de abertura do robô são enviados por SSH na primeira vez; com muito volume de gravações a lista usa uma consulta só por tela.

### 4. Tela "Carregando…" do Agente IA
- Agora nunca fica presa: após 20 s mostra o motivo provável e o botão **Tentar de novo**. Se aparecer, confira o SQL, `prisma generate` e reinício do backend; se continuar, mande o erro vermelho do console (F12).


---

## Atualização: recarga pelo cliente, extrato, saldo baixo e painel de lucro

### Passos para atualizar
1. Rode no banco o trecho novo no fim de `docs/atualizar_banco_pbx_avancado.sql` (colunas em `wallets` e `wallet_txs` e a tabela `wallet_topups`).
2. Backend: `npx prisma generate` e reinicie. Frontend: gere a build.
3. O Asaas precisa estar ativo (`ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`) e o webhook apontado para o mesmo endereço que você já usa para os planos. **No painel do Asaas, marque também os eventos de cobrança avulsa (PAYMENT_CONFIRMED / PAYMENT_RECEIVED)** — são os mesmos eventos dos planos.

### Recarga pelo cliente (Gateway de telecom → Saldo)
- O cliente informa o valor (mínimo/máximo definidos por você), na 1ª compra informa CPF/CNPJ, e paga na página segura do Asaas (Pix, cartão ou boleto).
- Pagamento confirmado → o saldo entra sozinho (uma única vez, mesmo que o Asaas avise duas vezes), a mensalidade de número em atraso é cobrada e o número suspenso volta.
- Uma recarga **nunca** renova o plano (são cobranças separadas).
- Se a conta ainda não era pré-paga, a 1ª recarga liga o pré-pago (pode desligar essa opção). **Defina as tarifas da conta** (SMS, minuto) em "Administração dos saldos", senão o uso sairá de graça.

### Extrato
- O cliente escolhe o período e vê recargas, ligações (minutos), SMS (partes) e mensalidades, com download em planilha (CSV).

### Saldo baixo
- E-mail automático (no máximo 1 por dia; zera quando recarrega) e faixa vermelha dentro do sistema. Limite padrão definido por você; o cliente pode ter o próprio limite.
- O e-mail usa o SMTP do sistema (`SYSTEM_SMTP_*`) ou o e-mail do administrador.

### Painel de lucro (só administrador, mesma aba Saldo)
- Em "Custos e recarga" você informa o que paga ao fornecedor: R$/min das ligações feitas e recebidas, custo mensal de cada número, custo de SMS quando a operadora não tem custo cadastrado. O SMS usa o custo real por parte cadastrado em cada operadora.
- "Lucro por mês" mostra receita, custo, lucro e margem, e por cliente ao clicar no mês.
- Ligações e números cobrados **antes** de cadastrar os custos aparecem com custo zero (o custo é gravado no momento da cobrança).

### Limites
- Nada foi testado com o Asaas de verdade (sandbox/produção): teste primeiro no sandbox com uma recarga pequena.
- O custo das ligações é uma estimativa pela tarifa que você informa, não a fatura real da operadora.

---

## Atualização: termos, limites de telefonia, lista de bloqueio, financeiro e notas

### O que mudou
1. **Termos de Uso e Privacidade (LGPD):** páginas públicas `/termos` e `/privacidade`; o cadastro exige marcar o aceite; contas antigas veem uma janela pedindo o aceite no próximo acesso. O texto é um **modelo**: leve a um advogado e edite em **Administração → Termos e privacidade** (salvar muda a versão e todos aceitam de novo). Opcional no `.env`: `LEGAL_COMPANY_NAME`, `LEGAL_COMPANY_TAX_ID`, `LEGAL_CONTACT_EMAIL`.
2. **Limites de telefonia por plano:** no editor de planos (Administração → Planos) há 4 campos novos: SMS por mês, minutos de ligação por mês, números de telefone e agentes de IA. Vazio = ilimitado. O SMS e a ligação param ao estourar o limite do mês; número e agente de IA não passam do limite. O cliente vê o uso em **Minha assinatura**.
3. **Lista de bloqueio:** menu **🚫 Lista de bloqueio**. Quem responde SAIR/PARAR/STOP a um SMS, ou pede para sair no robô ou na IA, entra sozinho. SMS, ligações (manual, discador, robô, IA) e disparos pulam esses números.
4. **Primeiro acesso:** cartão "Comece por aqui" no Dashboard do dono/admin, só com os passos dos módulos do plano.
5. **Financeiro (Administração → 📈 Financeiro):** receita recorrente (MRR), clientes pagantes, em teste, inadimplentes, cancelamentos dos últimos 30 dias, receita por mês e por plano.
6. **Recibos e notas:** em **Minha assinatura** o cliente preenche razão social, CPF/CNPJ e endereço e vê/imprime recibos. No Financeiro você baixa a planilha do mês para o contador, emite as notas no sistema da prefeitura e registra aqui o número e o link; o cliente vê no recibo. **O sistema não emite a nota sozinho.**

### Como atualizar
1. Rode no Supabase o arquivo `docs/atualizar_banco_pbx_avancado.sql` (os comandos novos estão no fim; pode rodar de novo sem problema).
2. No servidor: `bash deploy/atualizar-servidor.sh --banco`.

### Cuidados
- Cadastros novos só entram marcando o aceite; teste com um e-mail novo.
- Quem já usa o sistema vê a janela dos termos uma vez. Só dono/admin consegue aceitar.
- Limites contam por mês (horário de Brasília). Os minutos contam as ligações encerradas.
- O CPF/CNPJ é validado pelos dígitos. Se o cliente digitar errado, o sistema avisa.

### Ajustes finais (fechamento da auditoria)
- **Disparos só para dono/administrador:** criar, pausar e apagar disparos agora exige dono ou administrador; o vendedor só acompanha (os botões somem para ele).
- **Aviso de vencimento por e-mail:** todo dia às 9h (Brasília) o dono recebe aviso 7, 3 e 1 dia antes do vencimento, no dia e 2 dias depois (vale também para o teste grátis). Cada aviso sai uma vez por vencimento. Precisa do e-mail do sistema configurado (SYSTEM_SMTP_*).
- **Números automáticos respeitam o limite do plano:** se o plano permite 1 número, o sistema não entrega 2.
- **Limite de minutos:** vale para as ligações que passam pelo seu Asterisk (as que você revende). Quem liga com a própria conta Twilio paga direto à Twilio e não conta nesse limite.
- **Chaves das operadoras:** conferido que ficam criptografadas e a API só devolve versão mascarada.

### Redefinição de senha por e-mail (corrigida)
**O que estava errado:** quando o Firebase estava configurado, o sistema confiava nele primeiro. O Firebase responde "enviado" mesmo quando o e-mail cai no spam ou não chega, e o sistema nunca tentava o e-mail próprio. Agora a ordem é:
1. Link próprio enviado pelo **e-mail do sistema** (SMTP do sistema → e-mail da conta do cliente → e-mail configurado na conta do administrador).
2. Só se tudo isso falhar, o Firebase entra como reserva.

**Novidades:**
- **Aviso ao administrador:** a cada pedido de redefinição você recebe um e-mail (nos e-mails dos administradores, `SUPERADMIN_EMAILS`) dizendo quem pediu, quando, de qual IP e se o e-mail chegou ao usuário. Se o envio ao usuário falhou, o aviso já traz o link pronto para você repassar. No máximo 1 aviso a cada 10 minutos por usuário.
- **Histórico:** em Administração → abrir a conta → Histórico aparecem "Pediu redefinição de senha" e "Link de senha enviado".
- **Enviar link ao cliente:** em Administração → abrir a conta, botão **📧 Enviar link de redefinição por e-mail** (para o responsável) e **📧 Enviar link** ao lado de cada usuário. O link vale 24 horas. Se o e-mail falhar, o painel mostra o link para você copiar e mandar pelo WhatsApp.

**Para funcionar:** configure o e-mail em Administração → E-mail do sistema (ou `SYSTEM_SMTP_HOST/PORT/USER/PASS` e `SYSTEM_MAIL_FROM` no `.env`) e use o botão de teste lá. Confira também que `FRONTEND_URL` é o endereço real (https://app.turboprospect.com.br), senão o link sai errado.

### Telas do cliente mais limpas
- Em **Configurações**, o cliente deixa de ver Telefonia (Twilio), SMS (Twilio), RCS, telefonia do discador e telefonia da IA. Em vez disso vê um aviso de que SMS e ligações já funcionam pela telefonia do plano. Quem já tinha configurado algo disso antes continua vendo, para não perder o acesso. O administrador sempre vê tudo.
- No **PBX → Instalação e IA**, os textos que falavam do "guia de instalação" e de escolher o Asterisk em Configurações só aparecem para o administrador. O botão **Aplicar no Asterisk** continua disponível ao cliente (ele aplica só a própria central).
- A configuração gerada do Asterisk (que traz o token interno) continua só do administrador.

---

## Backup automático do banco

O Supabase guarda cópias próprias conforme o seu plano, mas é bom ter uma sua. O script `deploy/backup-banco.sh` faz uma cópia compactada do banco (e dos anexos enviados) no próprio servidor.

### Como ligar (uma vez, no servidor)
```
cd ~/maquina-de-vendas
apt-get update && apt-get install -y postgresql-client
bash deploy/backup-banco.sh --instalar
```
Isso agenda um backup por dia, às 03:30, guarda 14 dias em `~/backups-maquina` e já faz o primeiro agora, para testar.

### Comandos úteis
- Backup agora: `bash deploy/backup-banco.sh`
- Ver os guardados: `bash deploy/backup-banco.sh --listar`
- Mudar quantos dias guardar: `BACKUP_DIAS=30 bash deploy/backup-banco.sh --instalar`
- Cópia fora do servidor (recomendado): configure o `rclone` com seu Google Drive e rode com `BACKUP_RCLONE_REMOTE=drive:backups`. Um backup só no servidor se perde junto com ele.

### Se der erro de versão
Se aparecer "server version mismatch", o `pg_dump` do servidor é mais antigo que o banco. Instale um mais novo (`apt-get install -y postgresql-client-17` ou `-16`; pode ser preciso adicionar o repositório oficial do PostgreSQL).

### Como restaurar (só em emergência)
```
gunzip -c ~/backups-maquina/banco_AAAA-MM-DD_HHMM.sql.gz | psql "URL_DO_BANCO_SEM_PARAMETROS"
```
Restaurar apaga e recria as tabelas. Faça isso num banco de teste antes, e peça ajuda para o banco de produção.


---

## Contatos duplicados e descadastro de e-mail

**Não precisa rodar SQL novo.** Basta atualizar o servidor: `bash deploy/atualizar-servidor.sh`.

### Contatos duplicados (telefone e e-mail)
- O sistema compara **telefone** (ignora +55, zero e o "9" extra do celular: `11 98888-7777` = `11 8888-7777`) e **e-mail** (sem diferença de maiúsculas).
- **Importar planilha:** se houver linhas repetidas (com contatos já existentes ou repetidas no próprio arquivo), aparece a pergunta: **Manter só 1 de cada**, **Manter duplicados** ou **Cancelar**. Ao manter só 1, quem já existe **não é criado de novo**, mas **é adicionado à lista** escolhida se ainda não estiver nela.
- **Novo contato manual:** se já existir, pergunta se quer manter duplicado ou não criar.
- **Limpeza dos que já existem:** em *Contatos* → **🧹 Duplicados**. Mostra os grupos repetidos, você escolhe qual manter (sugerido: o mais antigo) e o sistema junta: telefone/e-mail/endereço que faltavam, etiquetas, histórico, CRM, listas e ligações passam para o contato mantido. Quem tinha pedido para não receber mensagens continua bloqueado.
- Quem usa a API sem enviar a opção recebe o padrão "manter só 1".

### Descadastro de e-mail
- Todo e-mail de campanha (SMTP, Resend, SendGrid, Twilio e nativo) agora leva o link **Cancelar inscrição** no rodapé e o botão de "cancelar inscrição" do Gmail/Outlook (exceto Twilio, que só leva o link no rodapé).
- Você pode escolher onde o link aparece escrevendo `{{link_descadastro}}` na mensagem.
- Quem cancela **nunca mais recebe campanhas de e-mail**; o disparo pula esse endereço automaticamente. Isso vale **só para e-mail** (não bloqueia WhatsApp/ligação).
- Veja e gerencie a lista em **🚫 Lista de bloqueio → E-mails descadastrados** (também dá para descadastrar à mão ou reativar).
- Observação: o aviso de pessoas que cancelaram pelo provedor nativo antes desta versão continua marcado no contato como "não contatar".

### Sobre os testes
Testei o cálculo de duplicados, a assinatura do link de descadastro e a compilação do código. **Não rodei contra banco real** nem enviei e-mail de verdade: faça um teste enviando uma campanha para você mesmo e clicando em "Cancelar inscrição".

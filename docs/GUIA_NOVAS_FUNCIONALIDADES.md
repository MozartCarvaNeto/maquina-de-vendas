# Guia — Retorno agendado no CRM + Agente de voz com IA

Este pacote **só adiciona** funcionalidades. Os arquivos que já existiam foram alterados com o mínimo necessário (listados abaixo) e os módulos de ligação anteriores (Robô e Vendedor manual) continuam como estavam.

---

## 1. O que foi entregue

**CRM**
- **Agendar retorno** em cada card: data e hora num calendário, com atalhos (amanhã, 3 dias, próxima semana) e um lembrete escrito.
- **Aviso na tela inicial** com os retornos que vencem hoje e os atrasados, mais um selo no menu “CRM”. Opcionalmente, aviso do navegador.
- **Card vermelho** quando passa do horário sem o retorno ser marcado como feito, e amarelo no dia. Sai do vermelho ao clicar em **“Retorno feito”**.
- **Coluna final “Perdidos”** (criada sozinha se o quadro não tiver): motivo da perda, data para **revisitar** (ex.: nova promoção) e botão **Reativar lead**.

**Agente de voz com IA (3º sistema de ligação)**, na tela **Ligações → 🧠 Agente IA**
- A IA liga, conversa por voz, **qualifica** o cliente, consulta o **catálogo** (texto e/ou site) e só chama o vendedor quando a venda está pronta.
- **Passagem ao vendedor (modelo híbrido):** transfere a ligação ao vivo **ou** envia o contato no WhatsApp do vendedor, com o resumo e as informações coletadas.
- **Treinamento por mercado:** glossário técnico editável (já vem um modelo completo de **estúdios de piercing**), que também melhora o reconhecimento de voz.
- **Resultado vai para o CRM** automaticamente (lead quente, morno, retorno combinado, “não ligue mais”).
- **Teste sem custo de telefonia:** conversa por texto com o agente e ligação de teste para o seu celular.

---

## 2. Onde salvar cada arquivo

Extraia o zip **por cima** da pasta do projeto (`maquina-de-vendas`). Os caminhos já estão corretos.

**Arquivos NOVOS**

| Arquivo | Pasta |
|---|---|
| `aiVoicePresets.js`, `catalogService.js`, `aiVoiceEngine.js`, `aiCallService.js` | `backend/src/services/ai/voice/` (pasta nova) |
| `aiCallController.js`, `aiCallWebhookController.js`, `crmFollowUpController.js` | `backend/src/controllers/` |
| `aiCalls.routes.js` | `backend/src/routes/` |
| `aiCallWatchdogJob.js` | `backend/src/jobs/` |
| `AgenteIA.jsx`, `AgenteIA.css` | `frontend/src/pages/` |
| `AiAgentEditor.jsx`, `AiAgentSimulator.jsx`, `AiTranscriptModal.jsx` | `frontend/src/components/ai/` (pasta nova) |
| `FollowUpPanel.jsx`, `followUpUtils.js`, `FollowUps.css` | `frontend/src/components/crm/` |
| `useFollowUps.js` | `frontend/src/hooks/` |

**Arquivos SUBSTITUÍDOS** (cópia completa; guarde o original antes)

| Arquivo | O que mudou |
|---|---|
| `backend/prisma/schema.prisma` | 3 tabelas novas + campos de retorno/perdido no card + vínculo na ligação |
| `backend/src/server.js` | registra a rota `/api/ai-calls` e o watchdog |
| `backend/src/routes/crm.routes.js` | rotas de retorno agendado e perdidos |
| `backend/src/controllers/crmController.js` | quadro sempre com coluna “Perdidos”; mover para/de “Perdidos” registra e limpa o motivo |
| `frontend/src/pages/Ligacoes.jsx` | terceira opção “🧠 Agente IA” |
| `frontend/src/pages/CRM.jsx` | abre o card vindo do aviso; passa a coluna ao modal |
| `frontend/src/pages/Dashboard.jsx` | painel “Retornos de clientes” no topo |
| `frontend/src/components/layout/Sidebar.jsx` | selo de retornos no item CRM |
| `frontend/src/components/crm/KanbanCard.jsx`, `KanbanColumn.jsx`, `CardDetailModal.jsx` | cores, badges, agendamento e perdidos |

> Não há dependências novas: **não precisa de `npm install`**.

---

## 3. Passo a passo de instalação

1. **Feche** o servidor (janela preta) e faça uma **cópia de segurança** da pasta do projeto.
2. **Copie os arquivos** conforme a seção 2.
3. **Atualize o banco** (escolha UMA opção):
   - **A) Pelo terminal:** abra um terminal em `backend` e rode `npx prisma db push`.
   - **B) Pelo Supabase (sem terminal):** abra **Supabase › SQL Editor**, cole todo o conteúdo de `docs/atualizar_banco_agente_ia_e_retornos.sql` e clique em **Run**. Pode rodar mais de uma vez sem problema.
   - Nenhum dado existente é apagado: só são criadas tabelas novas e colunas novas vazias.
4. **Gere o cliente do banco:** em `backend`, `npx prisma generate` (o `.bat` já faz isso ao iniciar).
5. **Recompile o frontend:** apague a pasta `frontend\dist` e rode `npm run build` dentro de `frontend`. (O `.bat` só recompila se `dist` não existir.)
6. **Inicie** o sistema normalmente e abra **Ctrl + F5** no navegador. Se o app instalado (PWA) mostrar “Nova versão disponível”, clique em **Atualizar agora**.

> **Supabase e a cota de egress:** enquanto a cota não renovar (9/10), o banco pode recusar conexões e nenhuma tela carrega. A instalação do passo 3-B funciona pelo painel do Supabase mesmo assim; o teste das telas só depois da renovação (ou com o plano Pro).

---

## 4. Como usar — Retorno agendado e Perdidos

**Agendar um retorno**
1. No **CRM**, clique no card do cliente.
2. Em **“📅 Retorno agendado”**, escolha data e hora (ou um atalho) e, se quiser, escreva um lembrete. Clique em **Agendar retorno**.

**O que acontece depois**
- No dia, o cliente aparece no painel **“🔔 Retornos de clientes”** da **tela inicial** e o menu **CRM** ganha um selo com o número de pendências. Clique em **Abrir no CRM** para ir direto ao card.
- O card fica **amarelo** no dia e **vermelho** assim que passa do horário combinado, até você marcar **“✅ Retorno feito”**. A coluna mostra um selo ⚠️ com quantos atrasos ela tem.
- Ao marcar **Retorno feito**, você pode anotar o que aconteceu e já agendar o **próximo** retorno.
- Para ser avisado pelo navegador (mesmo com outra aba aberta), clique em **“Ativar avisos no navegador”** no painel.
- A tela consulta um resumo muito pequeno a cada 60 segundos, só com a aba visível (não pesa no Supabase).

**Clientes perdidos**
- No card, **“🚫 Marcar como perdido”**: escolha o motivo e, se quiser, **“Revisitar em”** (30, 60 ou 90 dias). O card vai para a coluna **Perdidos**, sempre no final do funil.
- Se a data de revisita chegar, o cliente volta a aparecer no aviso da tela inicial.
- Para recuperar: abra o card em “Perdidos” e clique em **♻️ Reativar lead**. Arrastar o card para outra coluna também funciona.

> **Regra do vermelho:** o card fica vermelho quando o **horário** agendado passa. Se preferir só no **dia seguinte**, em `frontend/src/components/crm/followUpUtils.js` troque a primeira condição de `getFollowUpState` para `if (startOfDay(date).getTime() < startOfDay(now).getTime()) return 'overdue';`.

---

## 5. Como usar — Agente de voz com IA

### Antes de começar (uma vez)
1. **IA configurada:** em **Configurações › Inteligência Artificial**, cadastre a chave do Gemini ou da OpenAI (o agente usa a mesma).
2. **Twilio e número de saída:** os mesmos do Robô de Ligações (Configurações da Twilio e **Linhas › Números de Discagem**).
3. **Endereço público do servidor:** `BACKEND_PUBLIC_URL` no `backend/.env` precisa ser um endereço que a Twilio alcance (domínio ou túnel como ngrok). É o mesmo requisito do Robô.
4. **WhatsApp conectado** (para avisar o vendedor e enviar mensagens ao cliente).

### Passo 1 — Criar o agente
**Ligações › 🧠 Agente IA › Agentes › + Novo agente.**
1. Escolha o modelo **“Estúdios de piercing — venda de joias (atacado)”** e clique em **Aplicar modelo**. Ele já traz roteiro, ~25 termos técnicos (titânio ASTM F136, rosca interna, threadless, labret, clicker, calibre/gauge…) e perguntas de qualificação.
2. **Identidade:** nome da sua empresa (como a IA se apresenta), nome da assistente e voz.
3. **Treinamento do mercado:** edite o glossário. Para outro mercado, use o modelo “Genérico” e cole os seus termos (um por linha: `termo: significado`).
4. **Catálogo:** cole produtos, medidas e preços **e/ou** informe o site e clique em **Ler site agora** (nas campanhas o site é relido sozinho a cada 24 h). A IA só cita o que estiver aqui; o resto ela diz que o consultor confirma.
5. **Passagem para o vendedor:** escolha **WhatsApp** ou **transferir a ligação** e informe o telefone do vendedor (ou escolha um vendedor cadastrado).
6. Salve.

### Passo 2 — Testar (obrigatório antes de ligar para clientes)
- **Aba “🧪 Testar”, conversa por texto:** escreva como o cliente responderia e veja a IA, o que ela coletou e quando chamaria o vendedor. Não gera custo de telefonia.
- **“Ligar para o meu celular”:** teste real, com voz e reconhecimento de fala. O resultado aparece em “Últimos testes”. Ligações de teste **não** alteram leads nem o CRM.

### Passo 3 — Campanha
**Campanhas › + Nova campanha:** nome, agente, público (todos / lista / status), **horário permitido** (padrão 09:00–18:00, seg a sex), número de saída e ritmo. Clique em **Iniciar**.
- Fora do horário a campanha **pausa sozinha**; no dia seguinte clique em **Retomar**: continua do próximo contato, **sem repetir** quem já foi ligado. Se o servidor reiniciar, ela também retoma sozinha.
- **Ver resultados:** lista cada ligação com resultado, status da passagem ao vendedor, duração e **Ver conversa** (transcrição, resumo e dados coletados).

### O que a IA faz com cada resultado
| Resultado | O que o sistema faz |
|---|---|
| 🔥 Quente | Passa ao vendedor (transferência ou WhatsApp); lead vira “Qualificado”; card no CRM com resumo e dados coletados. Se o vendedor não atendeu ao vivo, o card nasce **com retorno para agora** (vermelho). |
| 🌤️ Morno | Card em “Em Qualificação” com retorno em 2 dias úteis e, se configurado, WhatsApp ao cliente. |
| 📅 Retorno combinado | O cliente pediu para ligar depois: a IA combina dia e hora e o retorno é **agendado no CRM**. |
| 🚫 “Não ligue mais” | O lead é bloqueado automaticamente (opt-out). |
| Número errado / caixa postal / sem resposta | Registrado na campanha; número errado recebe a tag `numero_errado`. |

---

## 6. Limites e cuidados (leia)

- **Teste real:** a lógica foi validada com simulações (conversa, transferência, CRM, telas), mas **não conectei na sua Twilio**. Faça o teste do passo 2 antes de qualquer campanha.
- **Latência:** a conversa é por turnos (a Twilio transcreve, a IA responde, a Twilio fala). Há uma pausa natural de 1 a 3 segundos entre as falas. Para respostas ainda mais rápidas no futuro existe um modo de streaming da Twilio, que exigiria uma etapa de infraestrutura adicional.
- **Vozes:** o campo de voz aceita os nomes de voz da Twilio. Se alguma voz da lista não funcionar na sua conta, use o campo “Outra” com o nome conforme a documentação de vozes da Twilio. A voz padrão é a Polly **Camila (neural)**.
- **Custos:** cada ligação consome minutos de telefonia e reconhecimento de fala da Twilio mais as chamadas à sua IA. Comece com poucas ligações e acompanhe o custo.
- **Transparência e legislação:** a IA se apresenta como assistente virtual e a gravação (se ativada) é avisada. O horário, o consentimento dos contatos e as regras de telemarketing são responsabilidade da sua operação; confirme as regras vigentes com seu assessor jurídico.
- **Qualidade da IA:** a IA pode errar. O glossário, o catálogo e os critérios de passagem são o que mais melhora o resultado: revise as conversas em “Ver conversa” e ajuste o agente.
- **Egress do Supabase:** o agente guarda o agente e a IA em memória por 5 minutos e lê o catálogo em trechos; cada fala da ligação faz poucas consultas pequenas.

---

## 7. Problemas comuns

| Sintoma | O que verificar |
|---|---|
| “Nenhuma IA configurada” | Configurações › Inteligência Artificial: chave salva e ativa. |
| Erro ao abrir a aba Agente IA | Banco não atualizado (passo 3) ou servidor não reiniciado. |
| “BACKEND_PUBLIC_URL precisa ser público” | Ajuste no `backend/.env` e reinicie. |
| Atende e fica mudo / a IA não responde | A Twilio não alcança o servidor: confira o endereço público e se o túnel está ativo. |
| “Ler site” não encontra texto | O site carrega por JavaScript: cole o catálogo em texto. |
| Aviso do navegador não aparece | Clique em “Ativar avisos no navegador” e permita as notificações. |
| Tela “presa” na versão antiga | Ctrl + F5; no app instalado, “Atualizar agora”. |

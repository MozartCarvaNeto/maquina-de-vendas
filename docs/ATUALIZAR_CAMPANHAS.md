# Turbo Prospect — Atualização "Campanhas inteligentes"

## O que muda
1. **Origem do lead**: cada lead agora guarda de qual campanha veio e por qual canal (Facebook/Instagram Ads, Google Ads, indicação, site, cliente existente, contato espontâneo). Aparece na lista de Contatos e na nova aba **Campanhas › Resultados por origem**.
2. **Como o robô descobre a origem** (nesta ordem):
   - **Anúncio "Clique para o WhatsApp" (Facebook/Instagram)**: o WhatsApp informa o anúncio; o sistema reconhece sozinho.
   - **Código no link (Google Ads, bio, site)**: em *Campanhas › Origem* gere o **link rastreável**. Ele abre o WhatsApp com a mensagem "Olá! Quero saber mais. Código: XXXX". Quando o lead envia, entra na campanha certa.
   - **Lead que já estava numa campanha**: continua nela.
   - **Cliente que já comprou** (data de compra ou etiqueta "cliente"): origem "Cliente", atendido pela campanha padrão (sem refazer qualificação).
   - **Sem código**: campanha marcada como **Padrão** (clientes regulares, indicações, quem já compra no site).
3. **Robô guiado**: a Nova Campanha tem 6 abas (Origem, Robô, Conhecimento, Qualificação, Follow-up, Testar). Os campos (nome do atendente, objetivo, tom, oferta, regras, proibições, FAQ, quando passar para humano...) montam o prompt automaticamente. Na aba **Testar** você conversa com o robô e vê o prompt completo antes de ativar.
4. **Conhecimento**: endereço do site (lido automaticamente), catálogo colado em texto ou arquivo .txt/.csv. Cada campanha pode ter um catálogo diferente. O robô só cita produtos/preços que estão ali.
5. O robô agora **registra as respostas de qualificação** na conversa e, ao terminar, qualifica o lead e manda ao CRM. Se pedir um humano, o lead ganha a etiqueta `atendimento-humano` e o robô para (remova a etiqueta para ele voltar).
6. **10 IAs**: Gemini, ChatGPT, Claude, Groq, DeepSeek, Mistral, Grok, OpenRouter, Together e "outra compatível com OpenAI". A chave é testada ao salvar.
7. Setas **← Voltar** e **🏠 Início** em todas as páginas (topo no celular; abaixo do menu no computador) e "Voltar ao login" nas telas de cadastro/senha.
8. Correções: o robô lia as 20 mensagens *mais antigas* da conversa (agora lê as mais recentes); campanha inativa não responde mais; a edição de campanha não aceita mais campos arbitrários.

9. **WhatsApp por campanha**: na aba Origem você escolhe qual número (conexão) pertence à campanha. Quem escreve para esse número entra na campanha mesmo sem código, e os follow-ups/nutrição saem por ele. Sem escolher: o robô responde pelo número em que o lead escreveu, e o follow-up usa o número da última conversa (antes usava sempre o primeiro conectado).

## Como instalar
1. Extraia o zip **por cima** da pasta do projeto (substitui os arquivos).
2. No GitHub Desktop: confira os arquivos alterados, escreva "Campanhas inteligentes" e clique **Commit** e **Push**.
3. No servidor (SSH): `cd /caminho/do/projeto && bash deploy/atualizar-servidor.sh --banco`
   (com Docker: `bash deploy/atualizar-docker.sh --banco`).
   O `--banco` cria as colunas novas. Alternativa: rode `docs/atualizar_banco_campanhas.sql` no SQL Editor do Supabase.
4. Configurações › Inteligência Artificial: cadastre a chave de uma IA (se ainda não tiver).
5. Campanhas: crie uma campanha para cada origem e **marque uma como Padrão**.

## Roteiro de teste
- Crie campanha "Google" com um código, gere o link rastreável, abra no celular e envie. O lead deve aparecer em Contatos com origem "Google Ads".
- Aba Testar: simule um lead de cada origem e veja o tom mudar.
- Resultados por origem: confira as contagens.

## Observações honestas
- O reconhecimento automático de anúncios do Facebook depende de o WhatsApp repassar os dados do anúncio. Na API Oficial da Meta isso é padrão; no WhatsApp por QR Code é feito pelo possível e **pode não vir** — por isso use também um código no texto do anúncio/link.
- Google Ads não envia dados ao WhatsApp: use sempre o link rastreável.
- Se a IA responder que não tem informação de um produto, o catálogo está incompleto: complete na aba Conhecimento. Sites que só carregam por JavaScript podem não ser lidos; cole o catálogo em texto.
- O teste de IA e as respostas do robô consomem créditos da chave de IA do próprio cliente.

## "O sistema funciona como o n8n?"
Não exatamente. O n8n é uma ferramenta genérica em que você desenha fluxos ligando centenas de apps. O Turbo Prospect é um produto pronto para vendas: o fluxo (anúncio → WhatsApp → robô qualifica → CRM → discador) já vem montado e é configurado por formulários, sem desenhar nada. Você ganha simplicidade; perde a liberdade de criar qualquer automação. Se um dia precisar ligar a outros sistemas (planilhas, ERP), o caminho é adicionar webhooks de entrada/saída — pode ser a próxima atualização; um n8n pode conviver com o sistema por esse meio.

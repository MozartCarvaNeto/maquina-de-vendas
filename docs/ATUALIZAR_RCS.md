# Disparos por RCS

## O que é
RCS é a mensagem "rica" do Android (app Google Mensagens): cartão com imagem, botões ("Abrir link", "Ligar") e respostas rápidas, com nome da sua marca verificada. iPhones recentes também recebem RCS em parte das operadoras; aparelhos sem RCS recebem SMS (se o fallback estiver ativo).

## Antes de tudo (fora do sistema)
Todo provedor de RCS exige um **agente RCS verificado** (cadastro da sua empresa/marca no Google e nas operadoras). Isso é feito no painel do provedor (Twilio, Zenvia, Infobip, Sinch, Pontaltech, Take Blip...) e pode levar dias. Sem agente aprovado o RCS não sai. Confirme com o provedor se RCS está liberado para o Brasil na sua conta.

## Instalar
1. Descompacte o zip por cima do projeto, recompile o frontend e rode `pm2 restart maquina`. Não precisa mexer no banco.
2. No `backend/.env`, confira `BACKEND_PUBLIC_URL=https://seudominio.com.br` (obrigatório para enviar IMAGEM: o provedor baixa a imagem desse endereço, que precisa ser https e público). Depois `pm2 restart maquina --update-env`.

## Cadastrar o provedor (Configurações > RCS)
**Twilio:** crie um Messaging Service com o remetente RCS (e, de preferência, um número de SMS no mesmo serviço: aí a Twilio envia SMS/MMS sozinha quando o celular não tem RCS). Cole o ID `MG...` no campo. Usa as mesmas chaves de Configurações > Telefonia. Se a conta não usar Messaging Service, use `rcs:nome_do_agente` (nesse caso não há SMS automático).

**Outra empresa brasileira (Zenvia, Infobip, Sinch, Pontaltech...):** escolha "Outra empresa (API HTTP)" e preencha:
- Endereço da API (da documentação do provedor);
- Nome e valor do cabeçalho de autenticação (ex.: `X-API-TOKEN` e o token; ou `Authorization` e `Bearer ...`);
- ID do agente RCS;
- Modelo do corpo (JSON): copie o exemplo do manual do provedor e troque os dados por `{{toDigits}}` (ou `{{to}}`), `{{text}}`, `{{title}}`, `{{imageUrl}}`, `{{sender}}`, `{{buttons}}`, `{{suggestions}}`. Os dois modelos prontos são apenas pontos de partida.
Use **Enviar RCS de teste** com seu próprio celular para conferir.

## Criar o disparo (Disparos > Novo disparo > RCS)
Título do cartão, mensagem (aceita `{{nome}}`), imagem, até 4 botões (link ou ligar), até 4 respostas rápidas, SMS de segurança (para provedores "Outra empresa") e velocidade (de 1 a cada 2 s até 20/s). Há prévia do cartão na tela. HTML não existe em RCS: se colar HTML, as marcas são removidas; o visual vem do cartão.

## O que NÃO está incluído ainda
- Relatório de entregue/lido (precisa de webhook de status de cada provedor).
- Receber e tratar as respostas rápidas/"SAIR" automaticamente.
- Carrossel de vários cartões.
- Os formatos dos provedores "Outra empresa" não foram testados contra as APIs reais; por isso o modelo é editável.

## Boas práticas
Envie só para quem aceitou receber; inclua no texto como sair da lista; comece com velocidade baixa e aumente aos poucos.

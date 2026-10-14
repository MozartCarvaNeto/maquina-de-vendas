# Ligações da IA: vozes mais naturais e alternativas à Twilio

**Nada do que funcionava foi removido.** Se você não mexer em nada, as ligações continuam exatamente como antes
(Twilio + voz Polly). Tudo abaixo é opcional e escolhido por agente / por configuração.

## 1) Voz mais natural (resolve o "voz de robô")
No editor do agente (Ligações > Agente de IA > Identidade > Voz) a lista agora tem 3 grupos:
- **Amazon Polly (padrão)** — como sempre foi.
- **Google Chirp 3 HD** — vozes mais naturais tocadas direto pela Twilio (sem integração extra; custo é o da Twilio).
- **Gemini (recomendada)** — as mais realistas. Usam a **chave do Gemini** que você já cadastra em
  Configurações > Inteligência Artificial. O sistema gera o áudio de cada fala e a operadora toca (`<Play>`).
  Sugestões para começar: **Achird** (amigável), **Sulafat** (calorosa), **Kore** (firme).
  - Botão **▶ Ouvir amostra**: escuta a voz escolhida (com o glossário de pronúncia do agente) sem precisar ligar.
  - Botão **Mais vozes pt-BR (Gemini)**: carrega a biblioteca ampliada em português do Brasil.
  - **Segurança:** se o Gemini falhar (sem cota, demora, sem chave), a ligação segue com a voz Polly. A conversa não cai.
  - Pronúncia ("Piercing Express"): com voz Gemini vale só o que você escrever na coluna "Como falar" do glossário
    (o dicionário embutido é para a voz Polly).
  - Os áudios gerados ficam em `uploads/ai-tts` e são apagados sozinhos depois de 12 horas.
  - Opcional no `.env`: `GEMINI_TTS_MODEL=...` para fixar o modelo de voz (padrão: gemini-3.8-flash-lite-tts, com
    reserva automática para outros modelos de voz do Gemini).
  - Atenção: gerar o áudio leva alguns instantes por fala; é a troca de naturalidade por um pouco de espera. Faça uma
    ligação de teste e, se achar lento, volte para Google Chirp 3 HD.

## 2) Operadora alternativa à Twilio só para a IA (Configurações > "Telefonia das ligações da IA")
O discador manual com vendedor continua na Twilio. Para a IA você escolhe:
- **Twilio (padrão)** — nada muda.
- **Telnyx (TeXML)** — mesma lógica de conversa, outra operadora, normalmente mais barata. Você informa a API Key v2
  e o ID de um TeXML Application. Cadastre o número da Telnyx em Linhas > Números de Discagem.
  Opcional no `.env`: `TELNYX_STT_ENGINE=google` (padrão: deepgram) para trocar o reconhecimento de fala.
- **Jambonz + tronco SIP** — o caminho para usar uma **operadora brasileira com minutos ilimitados** (Vozio,
  Voiicr, Avoip, Vivo Empresas...). O Jambonz (nuvem jambonz.cloud ou instalado no seu servidor) é a ponte entre
  o tronco SIP e a IA. No painel dele: cadastre o tronco em *Carriers*, ligue um reconhecimento de voz em *Speech*
  (obrigatório para a IA ouvir o cliente) e gere API Key + Account SID.
Ao salvar, o sistema **testa a conexão** antes de gravar; se falhar, nada muda e aparece "Salvar mesmo assim".
Voltar ao normal: escolha "Twilio" e salve.

### Limitações desta versão
- Telnyx e Jambonz foram implementados pela documentação oficial e testados com respostas simuladas;
  **ainda não foram testados com contas reais** — por isso comece sempre por uma **ligação de teste**.
- Gravação das ligações da IA e transferência para o vendedor ao vivo foram validadas só na Twilio.
- Planos "ilimitados" costumam proibir discador em massa (uso aceitável). Confirme com a operadora que ligação de IA
  conversacional é permitida e respeite as regras da Anatel e a LGPD para contato comercial.

## Como aplicar
Copie `backend`, `frontend` e `docs` por cima do projeto, `npm run build` no frontend e reinicie o backend.
**Não há SQL nem mudança de schema.** `BACKEND_PUBLIC_URL` precisa ser o endereço público do servidor (já é exigido
pelas ligações da IA): é de lá que a operadora baixa o áudio.

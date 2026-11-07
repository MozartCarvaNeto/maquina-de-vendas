# Telefonia PBX nativa: gravação, filas, URA e ligações da IA (sem Twilio)

## O que você ganha
Tudo roda no **seu Asterisk**, ligado ao seu tronco SIP:
- **Rotas de entrada**: o que acontece quando alguém liga para o seu número (por número ou por tronco), com **horário comercial** e destino "fora do horário".
- **URA** (menu de voz): "digite 1 para vendas…", teclas para fila, ramal, número externo, outra URA, caixa de recados ou sala de conferência; opção de digitar o ramal.
- **Filas de atendimento**: música de espera (sua), estratégia de toque (rodízio, todos, mais tempo parado…), tempo máximo e destino se ninguém atender.
- **Gravação** das chamadas recebidas e feitas (ouvir e baixar na tela) e **caixa de recados** (cliente deixa mensagem).
- **Histórico (CDR)** de todas as chamadas, com situação, duração e fila.
- **Clique para ligar** (toca o telefone do vendedor e, ao atender, liga para o cliente).
- **Ligações da IA pelo Asterisk**: a IA liga pelo seu tronco, conversa por voz e transfere para uma fila (ou para o celular do vendedor). Troque o provedor em *Configurações → Telefonia das ligações da IA → Asterisk*.

## Requisitos
- O sistema e o Asterisk no **mesmo servidor** (VPS). Asterisk **18.12+ ou 20** (precisa do AudioSocket para a IA). Ubuntu 22.04/24.04 e Debian 12 servem.
- Já ter feito o guia **Telefone SIP** (tronco cadastrado, nginx `/asterisk-ws`).
- Para a IA ouvir e falar: chave do **Gemini** em *Configurações → Inteligência Artificial* (usada para transcrever a fala e gerar a voz). Opcional: chave da OpenAI (Whisper) como reserva.

## Instalar (nesta ordem)
1. **Supabase → SQL Editor**: rode `docs/atualizar_banco_pbx.sql` (cria as 5 tabelas novas).
2. Copie o zip por cima do projeto. Depois: `cd backend && npx prisma generate`, recompile o frontend (`cd frontend && npm run build`) e `pm2 restart maquina`.
3. No servidor, **uma única vez**: `sudo bash deploy/instalar-pbx-asterisk.sh` (se o pm2 roda com outro usuário que não o root, passe o nome: `sudo bash deploy/instalar-pbx-asterisk.sh nomedousuario`). Ele cria as pastas de áudio/gravação, liga as configurações ao Asterisk e reinicia o Asterisk. Se mostrar "⚠️ Módulo … não encontrado", instale o que ele indicar. Depois: `pm2 restart maquina`.
4. No portal abra **🏢 Telefonia PBX**:
   - **Áudios**: envie (ou gere com a voz da IA) a saudação da URA e, se quiser, uma música de espera.
   - **Filas**: crie a fila e marque os atendentes (cada pessoa da equipe já tem um ramal).
   - **URA**: crie o menu e as teclas.
   - **Rotas de entrada**: aponte o seu número/tronco para a URA ou a fila; ligue o horário comercial se quiser.
   - **Instalação e IA → Aplicar no Asterisk**. Sempre que mudar algo nas abas, clique de novo em Aplicar.
5. Teste: ligue para o seu número de outro celular. Depois veja a ligação em **Chamadas e gravações**.
6. Ligações da IA: *Configurações → Telefonia das ligações da IA → Asterisk → Salvar*; em *Telefonia PBX → Instalação e IA* escolha para onde a IA transfere. Faça uma ligação de teste pelo Agente de IA.

## Vozes e reconhecimento de fala (Google, Microsoft, Amazon e outras)
Na tela **🏢 Telefonia PBX → 🗣️ Vozes e fala** você cadastra as chaves e testa:
- **Google Cloud**: vozes Chirp 3 HD / Neural2 e fala→texto. Pode deixar a chave em branco para usar a do Gemini. No Google Cloud ative a *Cloud Text-to-Speech API* e a *Speech-to-Text API*.
- **Microsoft Azure Speech**: vozes neurais pt-BR (Francisca, Antônio, Thalita…) e fala→texto. Crie o recurso "Speech" no Azure e copie a **Chave** e a **Região** (ex.: `brazilsouth`).
- **Amazon Polly**: vozes Camila, Vitória, Thiago (neurais) e Ricardo. Crie um usuário IAM só com a permissão `AmazonPollyReadOnlyAccess` e cadastre Access Key, Secret e a região.
- **ElevenLabs**: cadastre a chave; no Agente de IA use a voz `elevenlabs:IDDAVOZ`.
- **OpenAI** e **Gemini**: usam as chaves de *Configurações → Inteligência Artificial*.

A voz de cada ligação é a que está escolhida no **cadastro do Agente de IA** (as vozes novas aparecem na lista, as que só funcionam no PBX nativo vêm marcadas). Se a voz escolhida falhar na hora (chave errada, cota), a ligação continua com a voz Gemini padrão e o aviso fica no `pm2 logs`. Use **Ouvir amostra** para testar cada voz como o telefone vai receber.

Reconhecimento de fala (o que o cliente diz): escolha o motor na mesma tela (Automático = Gemini e, se falhar, OpenAI Whisper; ou Google; ou Azure) e use **Testar reconhecimento**. Amazon Transcribe não está disponível (exige transmissão contínua).
As IAs que "pensam" (Gemini, ChatGPT, Claude, Groq, DeepSeek, Mistral, Grok…) continuam sendo escolhidas no Agente de IA; para ligação, modelos rápidos (Gemini Flash, Groq, GPT-4o mini) respondem com menos silêncio.

## Se algo não funcionar
- **"Sem permissão para gravar em /etc/asterisk"** ao Aplicar: o passo 3 não foi feito (ou falta `pm2 restart maquina` depois dele). Alternativa: aba *Instalação e IA → Gerar arquivos para baixar*, copie para `/etc/asterisk/` e rode `sudo asterisk -rx "core reload"`.
- **URA/fila não atende**: `sudo asterisk -rx "dialplan show"` (procure `turbo-in-…`) e `sudo asterisk -rx "queue show"`. Se faltar, o include não pegou: confira as 4 linhas `#tryinclude` no fim de `pjsip.conf`, `extensions.conf`, `queues.conf`, `musiconhold.conf`.
- **Chamada não aparece no histórico**: o Asterisk precisa do módulo `func_curl` (`sudo asterisk -rx "module show like curl"`). Teste: `curl "http://127.0.0.1:3333/api/pbx-hook/ai-next?t=x"` deve responder `NO` (código errado = o caminho funciona).
- **IA liga mas fica muda / "Voz indisponível"**: confira a chave do Gemini e `sudo asterisk -rx "module show like audiosocket"`. Veja `pm2 logs maquina` (linhas "Ponte da IA").
- **Áudio MP3 não converte**: `sudo apt install ffmpeg` (WAV funciona sem).
- **Gravação não toca**: a pasta `/var/spool/asterisk/turbo-recordings` precisa existir (passo 3). Gravação só começa quando alguém atende.

## Limites desta versão (seja claro com seus clientes)
- Não testei contra um Asterisk e um tronco reais aqui: os testes cobriram a geração da configuração, a ponte da IA (com Asterisk simulado), gravações, URA/fila/rotas e o histórico. Faça os testes do passo 5 e 6 antes de usar com clientes.
- A IA pelo Asterisk não distingue "ocupado" de "não atendeu" (aparece como sem resposta) e o reconhecimento de fala tem alguns décimos de segundo de atraso a mais que a Twilio. Receber ligações **com a IA atendendo** (IA na entrada da URA) não está nesta versão — só IA ligando.
- Chamadas em andamento não aparecem em tempo real; entram no histórico quando terminam.
- Gravar ligações exige avisar o cliente (grave um aviso e coloque no começo da URA). Cuide da LGPD.
- Cada conta usa um código de 4 letras (o prefixo dos ramais); várias contas podem dividir o mesmo Asterisk.

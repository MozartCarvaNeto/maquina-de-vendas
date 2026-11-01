# Atualização: áudio no Chat do WhatsApp e ligações

## O que foi corrigido
**Áudio que você ENVIA**
- O áudio de voz saía com o tipo de arquivo incompleto (`audio/ogg` em vez de `audio/ogg; codecs=opus`). Nesse caso o celular do contato mostra o áudio como indisponível, e foi isso que você viu. Agora sai no formato certo de mensagem de voz.
- Se o servidor **não tiver o ffmpeg** (programa que converte o áudio gravado no navegador), antes o sistema enviava um áudio quebrado sem avisar. Agora ele avisa claramente. O Chat também mostra uma faixa amarela quando falta o ffmpeg.

**Áudio que você RECEBE**
- O áudio recebido é convertido para M4A e toca em qualquer aparelho (Chrome, Safari/iPhone, Edge). O WhatsApp manda OGG/Opus, que o iPhone não toca.
- Se o WhatsApp não liberar o arquivo na hora, o download é tentado 4 vezes (antes eram 3). Se ainda assim falhar, aparece o botão **"🔁 Tentar baixar de novo"** na própria mensagem.
- Se o aparelho não tocar o áudio, aparece um link para baixar o arquivo.

**Ligações**
- **Chamada recebida:** o sistema registra na conversa "📞 Chamada de voz/vídeo recebida (não atendida)", para você ligar de volta.
- **Botão "📞 Ligar"** no topo da conversa: faz uma ligação comum de telefone (pela Twilio e pelo seu telefone, como em Contatos), usando um número de discagem e um vendedor livre. **Não é chamada de WhatsApp.**

## Importante: chamadas de WhatsApp pelo sistema
O WhatsApp conectado por **QR Code** (WhatsApp Web) **não permite fazer nem atender chamadas de voz ou vídeo**. Isso é uma limitação do próprio WhatsApp: ele não oferece chamadas para sistemas desse tipo. Por isso não foi implementado. Os caminhos reais são:
1. **API Oficial da Meta (Cloud API) com o recurso "Calling"**, que permite chamadas de voz pelo navegador. Exige número aprovado e verificação do negócio na Meta, e depende de disponibilidade no seu país. Dá para construir, mas é um projeto grande à parte.
2. Seguir com o botão **📞 Ligar** (telefone comum) e atender chamadas de WhatsApp no celular onde o número está instalado.

## Como instalar
1. Copie as pastas `backend` e `frontend` do zip por cima do projeto (substituindo).
2. **Confirme o ffmpeg no servidor.** Com Docker, o `Dockerfile` do projeto já instala; reconstrua a imagem se ainda não fez. Sem Docker, rode no servidor: `sudo apt-get install -y ffmpeg`. Teste com `ffmpeg -version`.
3. Reinicie o backend e gere o frontend de novo (`npm run build` no frontend).
4. **Não precisa de SQL.**

## Como testar
1. Abra o Chat, escolha um contato e clique em 🎤: grave, clique em Parar e depois em Enviar. No celular do contato deve aparecer a mensagem de voz tocando.
2. Peça para alguém mandar um áudio. Ele deve aparecer com o player. Se aparecer o aviso de falha, clique em "Tentar baixar de novo".
3. Se aparecer a faixa amarela sobre o ffmpeg, faça o passo 2 da instalação.

# Turbo Prospect — Fotos, documentos, áudios e vídeos no WhatsApp

## O que estava errado
1. **Chat só entendia texto**: não existia nenhum lugar para guardar arquivos nas mensagens, e o botão de enviar exigia texto.
2. **Mensagens recebidas só com foto/documento/áudio eram descartadas** (o sistema ignorava toda mensagem sem texto) — por isso o chat "não recebia".
3. **Disparos aceitavam só JPEG** (tela, rota e servidor bloqueavam PNG, PDF etc.).
4. **API Oficial da Meta**: o link do anexo era montado errado (faltava a subpasta) e o webhook ignorava tudo que não fosse texto.

## O que agora funciona
- **Chat — receber**: fotos, vídeos, áudios/notas de voz, documentos (PDF, Word, Excel…) e figurinhas aparecem na conversa. Foto e áudio abrem sozinhos; vídeo toca ao clicar; documento baixa ao clicar. A lista de conversas mostra "📷 Foto", "🎤 Áudio", "📄 nome.pdf".
- **Chat — enviar**: botão **📎** (ou **arrastar o arquivo** para a conversa, ou **colar um print com Ctrl+V**). Escreva uma legenda se quiser. Aceita foto JPG/PNG/WebP/GIF, vídeo MP4, PDF, Word, Excel, PowerPoint, TXT, CSV, ZIP — até 16 MB.
- **Disparos**: 1 anexo por disparo no WhatsApp (foto, vídeo MP4 ou documento), até 16 MB; a mensagem vai como legenda. E-mail: até 5 anexos de 10 MB.
- Funciona nas duas conexões (QR Code e API Oficial da Meta).
- Os arquivos do chat são **privados**: só quem está logado na conta consegue abrir.
- Bloqueados por segurança: .exe, .bat, .js, .html, .svg e similares.

## Como instalar
1. Extraia o zip por cima da pasta do projeto (substituir arquivos).
2. GitHub Desktop: escreva "Fotos e documentos no WhatsApp" › **Commit** › **Push**.
3. No servidor: `bash deploy/atualizar-servidor.sh --banco`
   (o `--banco` é obrigatório: cria 5 colunas novas na tabela de mensagens).
   Se preferir, rode `docs/atualizar_banco_midia_whatsapp.sql` no SQL Editor do Supabase.
4. Os arquivos ficam em `backend/uploads/chat-media` (já está no volume `uploads` do Docker, então não se perdem ao atualizar).

## Como testar
1. Peça a alguém para enviar uma **foto** e um **PDF** para o número conectado → aparecem no Chat.
2. No Chat, clique em 📎, escolha uma foto, escreva uma legenda e Enviar → chega no celular do contato.
3. Em Disparos, crie um disparo de WhatsApp com uma imagem PNG ou um PDF.

## Observações honestas
- **Áudio/vídeo**: notas de voz do WhatsApp (OGG) tocam no Chrome/Edge/Firefox; no Safari/iPhone podem não tocar — use o botão do navegador para baixar. Vídeos que não sejam MP4/H.264 podem não rodar no navegador.
- **API Oficial da Meta**: aceita como foto só JPG/PNG; WebP/GIF vão como documento. Áudio não aceita legenda (o texto vai em mensagem separada). Respostas fora da janela de 24h exigem modelo aprovado.
- Mensagens recebidas **antes** desta atualização, que eram só mídia, não foram guardadas e não podem ser recuperadas.
- Localização e contatos compartilhados ainda não aparecem.
- O robô de atendimento responde só a texto; foto/áudio recebidos ficam no chat para um humano ver.

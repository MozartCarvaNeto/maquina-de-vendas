# Turbo Prospect — Fotos, documentos, áudios e vídeos no WhatsApp

## O que estava errado
1. **Chat só entendia texto**: não existia nenhum lugar para guardar arquivos nas mensagens, e o botão de enviar exigia texto.
2. **Mensagens recebidas só com foto/documento/áudio eram descartadas** (o sistema ignorava toda mensagem sem texto) — por isso o chat "não recebia".
3. **Disparos aceitavam só JPEG** (tela, rota e servidor bloqueavam PNG, PDF etc.).
4. **API Oficial da Meta**: o link do anexo era montado errado (faltava a subpasta) e o webhook ignorava tudo que não fosse texto.

## O que agora funciona
- **Chat — receber**: fotos, vídeos, áudios/notas de voz, documentos (PDF, Word, Excel…) e figurinhas aparecem na conversa. Foto e áudio abrem sozinhos; vídeo toca ao clicar; documento baixa ao clicar. A lista de conversas mostra "📷 Foto", "🎤 Áudio", "📄 nome.pdf".
- **Chat — enviar**: botão **📎** (ou **arrastar o arquivo** para a conversa, ou **colar um print com Ctrl+V**). Escreva uma legenda se quiser. Aceita foto JPG/PNG/WebP/GIF, vídeo MP4, PDF, Word, Excel, PowerPoint, TXT, CSV, ZIP — até **100 MB**. Foto, vídeo ou áudio acima de 16 MB (limite do WhatsApp para mídia) vão automaticamente como documento, sem perder qualidade.
- **Disparos**: 1 anexo por disparo no WhatsApp (foto, vídeo MP4 ou documento), até 16 MB (em disparo em massa, arquivo grande pesa para todos os destinatários); a mensagem vai como legenda. E-mail: até 5 anexos de 10 MB.
- Funciona nas duas conexões (QR Code e API Oficial da Meta).
- Os arquivos do chat são **privados**: só quem está logado na conta consegue abrir.
- Bloqueados por segurança: .exe, .bat, .js, .html, .svg e similares.

## Erro "Data passed to getter must include an id property"
Se, ao enviar foto/documento pelo WhatsApp (QR Code), aparecer esse erro, a causa é um bug da biblioteca whatsapp-web.js com a versão atual do WhatsApp Web (afeta todo envio de mídia; texto não). Esta atualização inclui a correção (`patchWwebjs.js`): ela se aplica sozinha toda vez que o sistema inicia, então **é preciso reiniciar o sistema** (o `atualizar-servidor.sh` / `atualizar-docker.sh` já faz isso). Depois de reiniciar, as conexões reconectam sozinhas e o envio de mídia volta a funcionar. Se um dia a biblioteca for atualizada e já vier corrigida, a correção se desativa sozinha.

## Como instalar
1. Extraia o zip por cima da pasta do projeto (substituir arquivos).
2. GitHub Desktop: escreva "Fotos e documentos no WhatsApp" › **Commit** › **Push**.
3. No servidor: `bash deploy/atualizar-servidor.sh --banco`
   (o `--banco` é obrigatório: cria 5 colunas novas na tabela de mensagens).
   Se preferir, rode `docs/atualizar_banco_midia_whatsapp.sql` no SQL Editor do Supabase.
3b. Se usa **nginx ou Caddy** (arquivos `deploy/nginx-maquina-de-vendas.conf` e `deploy/Caddyfile`), o limite de upload já foi elevado para 110 MB nesses arquivos. No servidor, depois do `git pull`: com nginx, copie o arquivo para `/etc/nginx/sites-available/` e rode `sudo nginx -s reload`; com Docker/Caddy, o `atualizar-docker.sh` já recria tudo. Sem isso, arquivos acima de 50 MB serão recusados.
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

## Se aparecer erro ao enviar um arquivo
A mensagem agora diz o motivo. Se for "servidor recusou o arquivo" / "conexão interrompida":
1. Veja se o nginx tem limite menor: `grep -rn client_max_body_size /etc/nginx/` (se não aparecer nada, o limite padrão é só 1 MB — foto de celular passa disso).
2. Coloque `client_max_body_size 110m;` no arquivo do seu site, depois `sudo nginx -t && sudo systemctl reload nginx`.
3. Se o erro for "Erro 500": veja o motivo com `pm2 logs` (ou `docker compose logs --tail=80 app`) logo após tentar enviar.

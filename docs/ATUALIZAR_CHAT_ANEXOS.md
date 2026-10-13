# Chat: abrir PDF e enviar/receber PDFs, áudios, fotos e outros arquivos

## O que mudou
**Receber / ver**
- PDF recebido ou enviado agora tem os botões **Abrir** (abre numa janela dentro do sistema, com opção
  "Abrir em nova aba") e **Baixar**. Antes só existia o download, por isso parecia que "não abria".
- Os outros documentos (Word, Excel, PowerPoint, TXT, CSV, ZIP) continuam com **Baixar**.
- Fotos, vídeos e áudios aparecem direto na conversa (já funcionava; mantido).

**Enviar**
- Fotos (JPG, PNG, WebP, GIF), vídeo MP4, **PDF**, Word, Excel, PowerPoint, TXT, CSV, ZIP e agora também
  **áudios** (MP3, OGG, M4A, AAC, AMR, WAV).
- Botão **🎤** grava a mensagem de voz pelo microfone: grave, ouça a prévia e envie. Vai como mensagem de voz.
- Arquivos cujo navegador não informa o tipo (PDF/DOCX arrastados, .ogg) agora são reconhecidos pela extensão.
- Prévia da foto/áudio antes de enviar. Fotos HEIC do iPhone são recusadas com a explicação de como enviar em JPG.
- Áudio gravado (WEBM/M4A) é convertido para OGG/Opus no servidor (ffmpeg) para o WhatsApp aceitar.
  Na API oficial (Cloud), áudio num formato não aceito e sem ffmpeg recebe uma mensagem clara de erro.

## Como aplicar
1. Copie `backend`, `frontend`, `docs` e o `Dockerfile` por cima do projeto.
2. **Docker (servidor):** `docker compose up -d --build` — a imagem agora inclui o ffmpeg.
   **Sem Docker (Windows):** funciona sem o ffmpeg (o áudio gravado vai sem conversão no WhatsApp nativo);
   para a melhor qualidade instale o ffmpeg e deixe-o no PATH.
3. Frontend: `npm run build` (ou reinicie o `npm run dev`). Não há SQL nem mudança de schema.

## Observações
- Gravar áudio exige o site em **https** (ou localhost) e a permissão de microfone no navegador.
- Limites do WhatsApp: documentos até 100 MB; foto/vídeo/áudio acima de 16 MB vão como documento.
  Se o envio de arquivos grandes der erro 413, aumente o limite de upload do proxy (nginx/Caddy).
- Anexo recebido que não baixa mostra "[Tipo recebido, mas não foi possível baixar…]" e o motivo vai para o log.

# Áudio do Chat: enviar e receber sem depender do servidor

## O que acontecia
O aviso amarelo do Chat mostrou o problema: **o seu servidor não tem o programa ffmpeg**. O navegador grava em WEBM, formato que o WhatsApp não aceita como mensagem de voz, e a conversão para OGG/Opus era feita só no servidor, que não tinha esse programa. Por isso o áudio não saía.

## O que mudou
**Enviar áudio**
- A conversão agora é feita **no próprio navegador** (Chrome/Android/Edge): ao parar a gravação, aparece "Preparando o áudio…" por um instante e o arquivo vira OGG/Opus, o formato exato da mensagem de voz do WhatsApp. O servidor **não precisa mais do ffmpeg** para isso.
- O aviso amarelo agora só aparece se o navegador também não conseguir converter (por exemplo, navegadores muito antigos).

**Receber áudio**
- O WhatsApp entrega o áudio em OGG/Opus, que o Chrome do Android e do computador tocam direto. Se o servidor tiver ffmpeg, ele ainda converte para M4A (para o iPhone).
- Quando o áudio não baixa, a mensagem agora mostra o **motivo** ("Motivo: …") e o botão **🔁 Tentar baixar de novo**. As tentativas passaram a atualizar a conversa no WhatsApp Web entre uma tentativa e outra, o que costuma destravar áudios.
- Importante: mensagens que já falharam **antes** da atualização não têm o botão (o sistema não guardava o código delas). Peça para o contato reenviar. As novas terão o botão.

## Instalação
1. Copie as pastas `backend` e `frontend` do zip por cima do projeto (este zip já inclui tudo do zip do telefone do WhatsApp).
2. Reinicie o backend e gere o frontend de novo (`npm run build`). **Limpe o cache do navegador** (ou abra em aba anônima) para carregar a versão nova.
3. Não precisa de SQL nem de instalar o ffmpeg.

## Como testar
1. Chat → escolha o contato → 🎤 → fale → ⏹ Parar → aguarde "Preparando o áudio…" → Enviar. No celular do contato deve aparecer a **mensagem de voz** com a onda sonora.
2. Peça para alguém mandar um áudio para o número conectado. Se aparecer o aviso de falha, anote o **motivo** que vem escrito e clique em "Tentar baixar de novo". Se continuar falhando, me mande o motivo e as linhas do log do servidor que começam com "⚠️ ... Anexo ptt ainda não baixou".

## Testado
O conversor foi testado num Chromium real: uma gravação de 3 s virou um OGG/Opus válido, com a duração certa, que decodifica sem erros. O envio e o download com o WhatsApp de verdade só podem ser confirmados no seu servidor.

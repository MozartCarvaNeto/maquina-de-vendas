# Telefone do WhatsApp no navegador (chamadas de voz)

## O que foi construído
- **Telefone no navegador** (WebRTC): liga e atende chamadas de voz do WhatsApp direto no Turbo Prospect, com tela de chamada, cronômetro e botão de mudo. O aviso de chamada recebida aparece em **qualquer tela** do sistema.
- **Servidor**: recebe as chamadas da Meta (webhook), atende, recusa, desliga e liga, e registra cada chamada na conversa ("📞 Chamada recebida — duração 2min 05s", "perdida", "não atendida").
- **Página "☎️ Telefone WhatsApp"** (menu): testa o microfone e a rede do computador, mostra se as chamadas estão ativas em cada número e ativa o recurso na Meta.
- **Botão "📞 WhatsApp"** no topo do Chat, quando o número escolhido é da API Oficial.

## Limite importante
Isso só funciona com números da **API Oficial da Meta (Cloud API)**. Número conectado por QR Code (WhatsApp Web) não faz nem recebe chamadas.

## O que a Meta exige (fora do sistema)
1. Número na **API Oficial** já cadastrado em Conexões.
2. **Limite de mensagens de 2.000 ou mais** no número (exigência da Meta para ativar chamadas).
3. No painel da Meta (app → WhatsApp → Configuração → Webhook), assinar o campo **`calls`** (além de `messages`). Sem isso, as chamadas recebidas não chegam.
4. Ativar o recurso no número: abra **Telefone WhatsApp** no menu e clique em **"Ativar chamadas neste número"**.
5. **Para ligar primeiro** para um contato, ele precisa ter autorizado. Quando a ligação for recusada por falta de permissão, o sistema mostra o botão **"Pedir permissão ao contato"**. Regras da Meta: a permissão vale 7 dias, são no máximo 2 pedidos por contato a cada 7 dias e 5 chamadas por contato a cada 24 h. Quem liga para você já autoriza a resposta.
6. Atender: a Meta dá cerca de 30 a 60 segundos depois que a chamada começa a tocar.
7. O sistema precisa estar em **https** (o navegador só libera o microfone assim).

## Instalação
1. Copie as pastas `backend` e `frontend` do zip por cima do projeto.
2. Reinicie o backend e gere o frontend de novo (`npm run build`).
3. **Não precisa de SQL.**
4. (Opcional) Se alguma rede bloquear o áudio, informe servidores de rede no `.env` do backend, por exemplo:
   `WEBRTC_ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:SEU_TURN:3478","username":"usuario","credential":"senha"}]`

## Como testar
1. Menu **☎️ Telefone WhatsApp** → "Testar microfone e conexão": todos os itens devem ficar ✅.
2. Mesma página → "Ver se as chamadas estão ativas" no seu número.
3. Peça para alguém ligar para o número da API Oficial: deve aparecer o cartão "Chamada recebida" com Atender/Recusar.
4. No Chat, escolha o número da API Oficial e use **📞 WhatsApp**.

## O que já foi testado e o que não
- Testado aqui: o motor de áudio num navegador real (Chromium) com microfone simulado. A proposta de conexão sai só com áudio Opus e com os caminhos de rede completos, e o áudio flui nos dois sentidos. Também foi testada a lógica do servidor com a Meta simulada: chamada recebida, atender (pre_accept e accept), recusar, ligar, resposta, status, encerramento e registro no chat.
- **Não testado com a Meta de verdade**, porque exige a sua conta, o número aprovado e o webhook. Na primeira chamada real, se algo falhar, mande a mensagem de erro que aparece no cartão (e o log do servidor) para eu ajustar.

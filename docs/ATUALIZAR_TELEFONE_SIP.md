# Telefone SIP no navegador (ligar e receber ligações comuns pelo portal)

## Como funciona
Navegador do vendedor ⇄ (WebSocket seguro) ⇄ **Asterisk** no seu servidor ⇄ **tronco SIP** do fornecedor de voz ⇄ operadoras.
- Cada pessoa da equipe ganha um **ramal automático** (criado quando abre o telefone pela primeira vez).
- Menu **📞 Telefone (ligações)**: teclado, ligar, mudo, desligar, teclas durante a ligação, histórico.
- Ligação recebida: aparece um aviso (e toca) em qualquer tela do sistema, com o nome do contato se o número estiver nos seus Contatos. Ela toca em todos os ramais de quem estiver com o sistema aberto; o primeiro que atender fica com ela.
- Cada ligação entra no histórico (quem, número, situação, duração).

## O que você precisa contratar
Um **tronco SIP** (também chamado de linha SIP / DID / "SIP trunk") de um fornecedor de voz: peça servidor, porta, usuário, senha, número de saída e se exige registro. Opcional: número(s) para receber ligações.

## Instalar (nesta ordem)
1. Supabase > SQL Editor: rode `docs/atualizar_banco_gateway_telecom.sql` (se ainda não rodou) e depois `docs/atualizar_banco_voz_sip.sql`.
2. Zip por cima do projeto, `cd backend && npx prisma generate`, recompile o frontend e `pm2 restart maquina`.
3. Instale o Asterisk no VPS (Ubuntu): `sudo apt install asterisk`.
4. No portal: **Gateway de telecom > Voz (SIP)** > cadastre o tronco > **Gerar arquivos** (isso também cria os ramais de toda a equipe). Baixe `pjsip_turbo.conf` e `extensions_turbo.conf` e copie para `/etc/asterisk/`.
5. No fim de `/etc/asterisk/pjsip.conf` acrescente: `#include pjsip_turbo.conf`. No fim de `/etc/asterisk/extensions.conf`: `#include extensions_turbo.conf`. Proteja: `sudo chmod 640 /etc/asterisk/pjsip_turbo.conf`.
6. Ative o WebSocket do Asterisk em `/etc/asterisk/http.conf` (apenas local; o nginx faz o https):
```
[general]
enabled=yes
bindaddr=127.0.0.1
bindport=8088
```
7. No nginx do seu site (dentro do `server { ... }` do https) acrescente:
```
location /asterisk-ws {
    proxy_pass http://127.0.0.1:8088/ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```
   Depois `sudo nginx -t && sudo systemctl reload nginx`.
8. `sudo systemctl restart asterisk`. Confira: `sudo asterisk -rx "pjsip show registrations"` (tronco Registered) e `sudo asterisk -rx "pjsip show contacts"` (aparece o ramal quando o telefone está aberto).
9. Firewall: libere UDP 10000–20000 (áudio) e as portas SIP que o fornecedor exigir. Se for só chamada de saída por UDP simples, geralmente basta o áudio.
10. Abra **📞 Telefone (ligações)**: deve aparecer 🟢 "Pronto para ligar e receber". Ligue para o seu celular.

Se o endereço do sistema (FRONTEND_URL) não for o mesmo do nginx do Asterisk, defina `ASTERISK_WSS_URL=wss://seudominio/asterisk-ws` no `backend/.env`.

## Se algo não funcionar
- 🔴 "Ramal ou senha recusados": gere os arquivos de novo (a senha mudou?) e recarregue: `sudo asterisk -rx "core reload"`.
- 🔴 "Sem conexão com o servidor de telefonia": confira o nginx (passo 7) e `sudo asterisk -rx "http show status"`.
- Liga mas sem áudio: quase sempre firewall UDP do áudio (passo 9) ou NAT; para redes difíceis configure um servidor TURN em `WEBRTC_ICE_SERVERS`.
- Fornecedor recusa a chamada: veja `sudo asterisk -rvvv` durante a ligação; ajuste "Prefixo para discar", "Número de saída" e codecs no tronco.

## Limites desta versão
- **Não testei com Asterisk nem com fornecedor de voz reais** (não consegui instalar aqui). O protocolo SIP do navegador foi testado contra um servidor simulado (registro com senha, ligar, receber, atender, recusar, cancelar, ocupado, desligar pelos dois lados, reconexão), mas os arquivos do Asterisk e o áudio ponta a ponta só serão confirmados no seu servidor. Se o Asterisk acusar erro na configuração, copie a mensagem de `asterisk -rvvv` e eu ajusto.
- Só ligação por voz comum (não é WhatsApp; para WhatsApp use o Telefone WhatsApp que já existe).
- Gravação de chamadas, fila de atendimento, URA e ligações da IA por este caminho não estão incluídas.
- Se o sistema estiver fechado, ninguém atende (ligações recebidas tocam só nos ramais com o sistema aberto).

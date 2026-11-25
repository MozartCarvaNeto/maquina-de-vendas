# WhatsApp sem navegador (Baileys): como testar e ligar

## O que é
Hoje cada número abre um Chromium (300-500 MB). O novo driver (`WHATSAPP_DRIVER=baileys`) conversa direto com o
WhatsApp, sem navegador: dezenas de MB por número. O resto do sistema (chat, disparos, CRM, robô, reconexão,
monitor de saúde) é o mesmo. **Vem DESLIGADO**: sem mexer no `.env`, nada muda.

## Avisos honestos
- Escrito e testado só com simulação (7 testes do driver + 4 do serviço). **Não foi testado com o WhatsApp real**:
  faça o teste abaixo com UM número antes de migrar os outros.
- Ao trocar de driver, **cada número precisa ler o QR de novo** (a sessão do Chromium não serve para o outro driver).
- Continua sendo conexão não oficial: o risco de bloqueio de número é parecido com o atual. Para escala/venda,
  a API Oficial da Meta continua sendo o caminho mais seguro.
- Chamadas recebidas viram aviso no chat, como hoje. Dependência: `@whiskeysockets/baileys` (versão 6.x).

## Passo a passo (no seu computador)
1. `cd backend && npm install` (instala o Baileys; ele é "opcional": se falhar, o modo atual segue funcionando).
2. Faça commit do `package.json` **e do `package-lock.json`** que mudaram e `git push`.
   (Assim o servidor não fica com arquivo alterado e o próximo `git pull` não dá conflito.)

## Testar no servidor com um número
1. `bash deploy/atualizar-servidor.sh` (não precisa do `--banco`).
2. Edite `backend/.env` e acrescente: `WHATSAPP_DRIVER=baileys`
3. `pm2 restart maquina`
4. Em **Conexões**, os números antigos aparecem *desconectados* (esperado: precisam de QR novo).
   Apague o número travado e conecte **um** com "Gerar novo QR".
5. Confira: `pm2 logs maquina --lines 40` (deve aparecer "WhatsApp conectado"), mande e receba uma mensagem de
   texto, uma foto, um PDF e um áudio pelo Chat, e rode um disparo pequeno.
6. Veja a memória: `free -h` e `pm2 status` (o processo `maquina` cresce poucas dezenas de MB por número).
7. Deu certo? Reconecte os demais, um de cada vez.

## Voltar atrás (rollback)
No `.env`: apague a linha `WHATSAPP_DRIVER` (ou `WHATSAPP_DRIVER=wwebjs`) e `pm2 restart maquina`. Os números
voltam ao modo antigo, também com QR novo (cada driver guarda a sessão do seu jeito).

## Arquivos
- `backend/src/services/whatsapp/baileysClient.js`: o driver (imita o cliente atual).
- `backend/src/services/whatsapp/nativeWhatsappService.js`: escolhe o driver; no modo Baileys o whatsapp-web.js nem é carregado.
- Testes: `node tests/baileysClient.test.js` e `node tests/whatsappBaileysDriver.test.js` (na pasta backend).

# WhatsApp: memória, sessões apagadas e capacidade do servidor

## O que foi corrigido (backend)
1. **Apagar uma conexão agora derruba o navegador de verdade.** Antes, se a conexão fosse apagada enquanto o
   navegador ainda estava abrindo (ou antes de ele existir), ele terminava de abrir "sozinho" e ficava ligado na
   memória para sempre, sem nenhuma conexão dona dele.
2. **Limpador de navegadores órfãos.** Ao ligar o servidor e a cada 2 minutos, o sistema encerra todo Chromium de
   sessão que nenhuma conexão ativa reconhece. Isso também limpa as sobras de reinícios forçados (o `pm2 restart`
   mata o programa em ~1,6 s, antes de fechar os navegadores).
3. **Pastas de sessão sem conexão** (de conexões já apagadas) são removidas ao ligar o servidor (libera disco).
4. **Proteção de capacidade.** Ao adicionar um número novo, se o servidor tiver menos de 400 MB de memória
   disponível, o sistema recusa com uma mensagem clara em vez de deixar tudo lento e falhando
   ("Waiting failed: 30000ms exceeded"). Ajuste com `WHATSAPP_MIN_FREE_MB` no `.env` (0 desliga).
5. **Medição real.** A cada 5 minutos o log mostra uma linha assim:
   `📊 WhatsApp: 5 sessão(ões) no sistema, 5 navegador(es) rodando, ~380 MB por sessão ...`
   Veja com `pm2 logs maquina --lines 200 --nostream | grep "📊"`.
   Se "sessões" for menor que "navegadores rodando" por muito tempo, ainda há vazamento: me envie essa linha.

## Como aplicar
Só o backend mudou (nenhuma tabela do banco):
```
cd ~/maquina-de-vendas
bash deploy/atualizar-servidor.sh
```
Teste automático (opcional, não precisa de internet): `cd backend && node tests/whatsappMemory.test.js`

## Limites para vender o sistema (importante)
- **Cada número de WhatsApp conectado pelo QR Code abre um Chromium próprio: ~300 a 500 MB.** É assim que a
  biblioteca (whatsapp-web.js) funciona; não dá para eliminar por código. O que dá é não desperdiçar (itens acima).
- **Estimativa de números por servidor** (deixando ~1,5 GB para o sistema, banco local e folga). Confirme com a
  linha 📊 do log:

  | Memória do servidor | Números simultâneos (aprox.) |
  |---|---|
  | 4 GB (o atual) | 4 a 6 |
  | 8 GB | 12 a 15 |
  | 16 GB | 28 a 32 |

- O sistema já tem um teto de 10 conexões por conta (`HARD_MAX_CONNECTIONS`) e limites por plano.
- Ao reiniciar, as sessões reabrem uma por vez (até ~2,5 min cada): com muitos números, a recuperação demora.
  Prefira atualizar fora do horário de uso.

## Caminhos para uso massivo (decisão de negócio)
1. **API Oficial da Meta (WhatsApp Cloud API)**: já suportada no sistema; não usa Chromium, não consome memória e não
   corre risco de bloqueio por automação. É o caminho recomendado para clientes grandes (cobrança por conversa pela Meta).
2. **Mais memória / mais servidores**: o mais simples para crescer pelo QR Code. Um servidor de 8 GB custa pouco mais
   que o de 4 GB e triplica a capacidade.
3. **Trocar a biblioteca** por uma que não use navegador (ex.: Baileys, ~30-60 MB por número): é uma reescrita grande
   e mais arriscada (instabilidade e banimentos); só vale com muitos números.

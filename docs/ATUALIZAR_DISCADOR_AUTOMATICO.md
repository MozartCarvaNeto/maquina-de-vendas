# Atualização — Discador Automático com equipe de vendedores

## O que estava errado (prints)
1. **"The phone number … +85998569283 is not valid"** e **"Account not authorized to call +41997103892"**: os leads têm o número salvo sem o +55 (ex.: 85 99856-9283 e 41 99710-3892). O sistema mandava para a Twilio assim, e ela entendia "85" e "41" como códigos de país. Agora todo número sem código de país é tratado como Brasil (+55), inclusive celulares antigos sem o 9. Vale para o discador, ligação com clique, robô de ligações e telefone dos vendedores.
2. O discador antigo só ligava **uma chamada de cada vez** e dependia de clicar; o modo automático encadeava a próxima ligação só depois do fim da anterior.

## Como o Discador funciona agora
- **Modo automático ligado** = um motor no servidor (a cada 4 s) liga para o próximo lead da fila **sempre que houver vendedor livre**.
- Cada discagem **já reserva um vendedor** (o que está livre há mais tempo → rodízio). Quando o lead atende, a chamada é passada a esse vendedor (conferência: o sistema liga para o celular dele).
- **Vários vendedores**: o discador chama vários leads ao mesmo tempo, um para cada vendedor livre; quando alguém termina, volta a discar e passa ao próximo livre.
- **Um vendedor só**: só disca de novo quando a linha dele estiver livre (conversa encerrada).
- **Pausa individual**: cada vendedor (pelo seu login) tem o botão "⏸️ Pausar meu atendimento" na tela Discador; vale só para ele, os outros continuam. O dono/admin pode pausar/retomar qualquer um. Vendedor em ligação não pode ser pausado até terminar.
- Se o **vendedor não atende o repasse**: o lead é desligado e volta ao início da fila, e o vendedor é pausado automaticamente (aparece "⏸️ Pausado" na equipe).
- Lead que **não atende**: volta para a fila (até 3 tentativas, com 60 min entre elas).
- Lead com opt-out, "perdido" ou telefone inválido é pulado sem travar a fila.
- Se a conta tiver problema geral (sem número de discagem, credencial Twilio inválida), o modo automático se desliga e a tela mostra o motivo.
- Seleção de lista: ao ligar o modo automático com uma lista escolhida e a fila vazia, a lista é carregada sozinha.
- A tela mostra a equipe (livre / em ligação / pausado), todas as ligações em andamento e atualiza sozinha.

## Como instalar
1. Rode `docs/atualizar_banco_discador_equipe.sql` no SQL Editor do Supabase (cria a pausa individual).
2. Copie os arquivos do zip por cima do projeto e atualize o servidor (`bash deploy/atualizar-servidor.sh`).
3. Em **Linhas**: cadastre cada vendedor com o celular (com DDD) e vincule o login dele em **Equipe** (campo vendedor) — é isso que faz o botão "Pausar meu atendimento" aparecer para ele.
4. Na **Twilio**, para ligar para o Brasil: Console → Voice → Settings → **Geo Permissions** → marque **Brazil**. Em conta Trial, só liga para números verificados.
5. No Discador: escolha a lista, clique em "Carregar lista na fila" e ligue o **Modo automático**.

## Limitações
- Se o lead atender por caixa postal, a Twilio avisa "atendida" e o vendedor receberá a chamada (a detecção de secretária no discador humano não foi incluída).
- O botão "Iniciar próxima ligação (manual)" continua existindo para discar um a um.

## Correções adicionais (botões da tela)
- **Encerrar ligação** agora funciona sempre: desliga o lead e o vendedor na Twilio (se já tinham terminado, o erro é ignorado) e fecha a ligação no sistema, liberando a fila e o vendedor. Ligações "presas" (a Twilio não avisou o fim) são fechadas sozinhas após 3 min chamando ou 90 min em conversa.
- **Limpar fila**: esvazia os contatos pendentes. Para **trocar de lista**: escolha a outra lista e clique em "Carregar lista na fila" (substitui a fila); "Adicionar sem limpar" soma à fila.
- **Parar discador**: desliga o modo automático e encerra todas as ligações do discador em andamento. (Desmarcar "Modo automático" só impede novas discagens.)
- A tela mostra **por que não está discando** (sem vendedor cadastrado, fila vazia, todos pausados…). Atenção: se aparecer "Vendedores disponíveis 0 / 0", cadastre os vendedores em **Linhas > Vendedores** — sem eles o automático não liga.

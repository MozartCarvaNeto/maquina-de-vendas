# Atualização: disparo envia 1 mensagem por contato e só para a lista do início

## O que acontecia (causas encontradas no código)
1. **O público era recalculado a cada execução.** Em "Todos os leads", "Por status" ou lista dinâmica, quem entrasse depois (por exemplo, um contato novo que respondeu e virou "Novo") passava a fazer parte do disparo em andamento. Por isso apareceram pessoas que não estavam na campanha.
2. **Pausar e retomar podia deixar duas ou três execuções rodando juntas.** Ao pausar, a execução antiga continuava "dormindo" na espera entre mensagens; ao retomar, nascia uma nova e a antiga acordava e voltava a enviar. Cada execução mandava a sua mensagem: 2 ou 3 por contato. O mesmo podia ocorrer se um envio travasse por mais de 3 minutos e o vigia do sistema abrisse outra execução.
3. **O mesmo telefone cadastrado mais de uma vez** (importações repetidas) virava vários leads, e cada um recebia a mensagem.

O código não tem nenhuma regra diferente para administrador e não administrador. A diferença que você viu veio das circunstâncias de cada disparo (pausar/retomar, lista usada, contatos repetidos).

## O que mudou
- **A lista é fixada quando o disparo começa.** Só esses contatos recebem. Leads novos não entram no meio. Em disparo **recorrente**, a lista é refeita no início de cada rodada.
- **1 mensagem por contato.** Cada contato é "reservado" antes do envio; mesmo que, por engano, existam duas execuções, a segunda não envia.
- **Telefones ou e-mails repetidos entram só uma vez** no disparo.
- **Pausar agora para na hora**, e retomar não duplica.
- **Quem pediu para não receber mensagens (opt-out) é pulado.**
- O vigia não abre uma segunda execução enquanto a primeira está viva, só lenta.
- A aba de acompanhamento ("Onde parou", Pendentes) passa a mostrar a lista fixada.

## Como instalar
1. Copie a pasta `backend` do zip por cima do projeto (3 arquivos) e reinicie o backend.
2. **Não precisa de SQL nem de alterar o frontend.**
3. Disparos que já estavam em andamento ou pausados: ao retomar, a lista é fixada naquele momento, e quem já recebeu não recebe de novo.

## Conferir no seu banco (opcional)
Rode `docs/diagnostico_disparo_duplicado.sql` no Supabase (SQL Editor). Ele só lê dados e mostra (1) telefones cadastrados em duplicidade e (2) quem recebeu mais de uma mensagem nas últimas 48 h.

## Observação
O sistema de follow-up automático (todo dia às 9h) manda mensagem a quem não respondeu depois de alguns dias, se a campanha de origem tiver follow-up ligado. Isso é outra função, separada do disparo. Se quiser, posso mostrar como conferir se está ligado.

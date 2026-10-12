# Atualização: relatório da ligação no Chat, um contato por cliente e apresentação sempre completa

Copie as pastas `backend`, `frontend` e `docs` por cima do projeto. **Sem SQL e sem mudança de schema.**
Depois: `npm run build` no frontend (ou o `deploy/atualizar-servidor.sh` / `atualizar-docker.sh`) e reinicie o backend.

## 1) Cada cliente vira uma conversa própria no Chat, com o relatório
- Ao fim de cada ligação com conversa, o relatório da IA entra no Chat **daquele contato** (nota interna) e a conversa sobe para o topo da lista. Cada cliente que atende abre a sua própria conversa, com o número dele; o seguinte não apaga o anterior.
- Na lista, quem é lead **quente / morno / retorno agendado** e ainda não recebeu resposta do vendedor ganha a etiqueta **🔥 Aguardando seu retorno**, o número do cliente embaixo do nome e o filtro **"🔥 Aguardando você (N)"** no topo. Quando você responde, a etiqueta some sozinha.
- Ao abrir a conversa, o **relatório fica fixado no alto** (resultado, resumo, informações coletadas, retorno combinado, conversa resumida e próximo passo), podendo recolher. Você responde ali mesmo, como se o cliente tivesse mandado a mensagem.
- O número de WhatsApp já vem escolhido: o mesmo que a IA usou com o cliente (ou o único conectado) — sem o passo "Selecione o número".
- A mensagem de apresentação que o sistema envia ao cliente depois da ligação agora também **aparece no chat** dele.
- A lista agora é ordenada pela **última mensagem** de cada conversa.

## 2) Ligação de teste: um contato por número
Antes, todo teste reaproveitava um único contato "Estúdio de Teste" e só trocava o número. Agora cada número de teste cria o seu contato ("Teste IA — +55…"), com sua própria conversa e relatório.

## 3) Apresentação da Luna (Piercing Express) sempre completa
- A **abertura da ligação não pode mais ser interrompida**: a IA fala a apresentação inteira e só depois começa a ouvir (se o cliente falar por cima, a fala não é cortada).
- Para o agente de piercing, a abertura sempre diz que representa a **Piercing Express, empresa atacadista de piercings, com uma infinidade de modelos em aço cirúrgico e titânio, com laudo e garantia, e envio rápido para todo o Brasil**. Vale também para o agente que você já criou: se a fala de abertura dele não tiver isso, o sistema acrescenta a frase automaticamente (se você já escreveu algo equivalente, nada é alterado). O modelo pronto "Estúdios de piercing" também foi atualizado.
- O limite de tamanho da abertura falada foi ampliado para caber a apresentação sem cortar a pergunta final.

## Como testar
1. Faça uma ligação de teste para o seu celular, converse e desligue.
2. Abra o Chat: aparece "Teste IA — +55…" no topo com 🔥 (se a IA classificou como quente/morno), o número e o relatório fixado.
3. Teste de novo com **outro número**: surge uma segunda conversa, a primeira continua lá.
4. Atenda a ligação e tente falar por cima da apresentação: ela deve ir até o fim ("…envio rápido para todo o Brasil").

## Observações honestas
- O relatório só aparece quando a ligação teve conversa (a IA ouviu o cliente pelo menos uma vez); ligações sem resposta, caixa postal, número errado e quem pede para não ligar não geram relatório.
- A etiqueta "Aguardando" depende da IA classificar o resultado como quente, morno ou retorno agendado.
- Ligações antigas ficam como estão; o ajuste vale para as próximas.
- Por não poder ligar de verdade daqui, testei a lógica (apresentação, TwiML da abertura, lista de conversas) com simulações; o teste real é o passo acima.
- A tela de telefonia/Twilio que preparamos antes ficou de fora, como você pediu, e pode entrar depois.

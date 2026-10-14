# Atualização — novas tentativas e "Perdidos" nas ligações da IA

## O que muda
1. **Quem não atende é chamado de novo.** Cada número recebe até **3 tentativas** (configurável de 1 a 10), com intervalo mínimo de **3 horas** (configurável) entre elas. Conta como "não atendeu": ninguém atendeu, ocupado, falhou ou caiu em caixa postal.
2. **Tudo automático.** Terminada a rodada, a campanha fica "Ligando" e aguarda o intervalo; fora do horário permitido ela espera e volta sozinha na próxima janela (não pausa mais). Só conclui quando todos atenderam, recusaram ou esgotaram as tentativas.
3. **Quem atendeu segue o fluxo de sempre** (quente/morno/retorno → CRM, relatório no chat) e não é chamado de novo.
4. **Quem recusou** ("não tenho interesse" ou "não ligue mais") vai para a coluna **Perdidos** do CRM (criada se não existir), o lead fica com status "perdido" e nunca mais entra em campanha. O relatório no chat informa isso. Cliente já em "Fechado" não é mexido.
5. Número errado e quem pediu para sair continuam bloqueados.
6. Os contadores da campanha passaram a contar **cada lead uma vez** (mesmo com 3 tentativas).

## Como instalar
1. Copie os arquivos do zip por cima do projeto (mantendo as pastas).
2. No servidor, rode a atualização com o banco: `bash deploy/atualizar-servidor.sh --banco`
   (ou rode `docs/atualizar_banco_tentativas_ligacoes.sql` no SQL Editor do Supabase e depois atualize normalmente).
3. Ao criar uma campanha, preencha "Tentativas por número" e "Intervalo entre tentativas".

## Observações
- Campanhas **já criadas** passam a usar o padrão: 3 tentativas, intervalo de 180 min.
- Quem foi chamado só uma vez em campanha anterior e não atendeu será chamado de novo ao retomar.
- Para reativar um lead em Perdidos, use "Reativar" no CRM.

## Também nesta atualização
- **Abertura da ligação:** a fala inicial agora é exatamente a que está em "Roteiro da ligação" do agente (o sistema não acrescenta mais a frase fixa da Piercing Express). Para mudar, edite o roteiro do agente e salve.
- **Ouvir amostra:** o botão agora fica ativo para todas as vozes e toca o início do seu roteiro. Vozes Gemini e Google Chirp 3 HD tocam; para o Chirp é preciso ativar a "Cloud Text-to-Speech API" na chave do Google (a tela avisa se faltar). As vozes Amazon Polly (ex.: Vitória) só existem dentro da ligação — para ouvi-las use "Ligar para o meu celular" na aba Testar.
- **Sem interesse → Perdidos:** vale para a IA e também para o robô de ligações (quem diz "sem interesse" ou aperta a tecla correspondente).

# Atualização — caixa postal, conclusão da ligação e lista no Discador

## 1) Caixa postal / secretária eletrônica
- A IA agora tem o resultado **"caixa postal"**: ao perceber que é gravação, desliga na hora (sem falar nem deixar recado).
- O sistema também reconhece caixa postal pela transcrição (frases como "deixe seu recado", "após o sinal", "não pode atender", "fora da área"…), mesmo que a IA tenha classificado errado.
- Caixa postal **não vai para Perdidos**, não gera relatório e conta como "não atendeu": a campanha tenta de novo (até o limite de tentativas).
- Atender e ficar mudo também conta como não atendido (nova tentativa).

## 2) Quem vai para Perdidos
Só quem é **pessoa de verdade** e recusou ("sem interesse") ou pediu para não ligar mais. Caixa postal, ocupado, sem resposta e número errado não vão para Perdidos.

## 3) Conclusão da ligação e card em "Qualificado"
- A IA recebeu a regra de **concluir de forma breve**: oferecer "o consultor te liga ou prefere o link no WhatsApp?", e quando o cliente aceitar confirmar em uma frase, agradecer e encerrar com resultado **quente**.
- **Rede de segurança:** se a ligação termina sem a IA ter classificado o lead (ou o cliente desliga no meio), o sistema analisa a transcrição e define o resultado. Cliente que aceitou o contato vira **quente** → card na coluna **Qualificado** do CRM, com relatório no chat. Antes, esses casos ficavam "inconclusivos".

## 4) Discador automático: seleção de lista
Na tela **Discador**, no cartão Configuração, há o campo **"Lista para discagem automática"**:
1. Escolha a lista de contatos (as listas criadas em Contatos > Listas).
2. Clique em **"Carregar lista na fila"** (limpa a fila pendente e coloca os contatos da lista) ou **"Adicionar sem limpar"**.
3. Com o **modo automático** ligado, clique em "Iniciar próxima ligação": depois de cada ligação o discador segue sozinho pela fila.
Entram só contatos com telefone, sem opt-out, não "perdidos", não pausados na lista e que não receberam ligação do discador nas últimas 12 h.
A lista escolhida fica salva.

## Como instalar
1. Copie os arquivos do zip por cima do projeto (mantendo as pastas).
2. Reinicie o backend e recompile o frontend como de costume: `bash deploy/atualizar-servidor.sh` (não há novas alterações de banco além do SQL da atualização anterior, que você já rodou).
3. Teste: faça uma ligação de teste aceitando o contato do consultor — deve aparecer o card em "Qualificado" e o relatório no chat.

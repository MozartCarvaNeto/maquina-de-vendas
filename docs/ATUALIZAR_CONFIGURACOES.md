# Correção: chaves de Configurações que "desapareciam"

## O que foi corrigido
1. **Rotas em ordem errada** (`server.js`): `/api/settings` (só administrador) vinha antes de `/api/settings/ai`
   e barrava quem não era dono/admin. Resultado: em Campanhas e no Agente IA a lista de IAs aparecia vazia.
   Agora `/settings/ai` vem primeiro: qualquer membro **lê** a lista de IAs; só dono/admin **altera** chaves.
2. **Chave nova de IA era apagada** quando o teste falhava (a mensagem dizia "salvas", mas o servidor apagava).
   Agora a chave é testada **antes** de gravar; se falhar, nada é apagado nem sobrescrito e aparece o botão
   **"Salvar mesmo assim (sem validar)"**.
3. **Telefonia e e-mail** desativavam a configuração antiga *antes* de testar a nova. Credencial errada passava
   a valer no lugar da boa (inclusive no lugar do `.env`). Agora testa primeiro e grava tudo numa transação.
4. **A tela não recarregava o que já estava salvo.** Agora ela mostra os campos comuns (SID, host, usuário,
   modelo...) e o final da chave (••••abcd). Campo secreto em branco = "manter a chave atual".
5. Espaços/quebras de linha colados junto com a chave são removidos (causa comum de "chave inválida").
6. Gravação de ligação com Twilio configurada só no `.env` não falha mais com "Telefonia não configurada".

## Como aplicar
1. Copie as pastas `backend`, `frontend` e `docs` deste pacote por cima do projeto (aceite substituir).
2. (Opcional, recomendado) Supabase > SQL Editor > cole `docs/atualizar_banco_configuracoes.sql` > Run.
3. Não há mudança de schema: **não** precisa de `prisma generate` nem de migration.
4. Frontend: `npm run build` (se você usa o frontend compilado) — ou só reinicie o `npm run dev`.
5. Reinicie o backend.

## Como testar
1. Configurações > IA: salve uma chave. Saia, abra Campanhas: a IA aparece no seletor "IA desta campanha".
2. Volte em Configurações: aparece "salva ••••xxxx" nos campos e a lista "Integrações já configuradas".
3. Digite uma chave errada de propósito: aparece o erro e "Salvar mesmo assim"; a chave boa anterior continua.
4. Faça login com um usuário vendedor: Campanhas deve listar as IAs (sem ver nenhuma chave).

> Chaves que já tinham sido apagadas por teste falho antes desta correção não voltam: cadastre-as de novo uma vez.

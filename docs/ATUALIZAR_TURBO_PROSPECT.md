# Atualização: novo nome Turbo Prospect + novo logotipo

## 1. No seu computador
1. Extraia o zip e copie as pastas (`backend`, `frontend`, `docs`, `deploy`...) por cima do projeto, aceitando substituir.
2. (Opcional, para testar) `cd frontend` → `npm run build` e abra o sistema.

## 2. GitHub (GitHub Desktop)
1. Abra o **GitHub Desktop** com o repositório `maquina-de-vendas`.
2. Na aba **Changes** devem aparecer ~35 arquivos (incluindo imagens `.png` em `frontend/public`). Se aparecer `.env`, `sessions` ou `node_modules`, PARE.
3. Em **Summary** escreva: `Novo nome Turbo Prospect e logotipo` → **Commit to main**.
4. Clique em **Push origin**.

## 3. Servidor (VPS)
No PowerShell: `ssh root@SEU_IP`, depois:

    cd ~/maquina-de-vendas
    nano backend/.env        # só se existir a linha APP_NAME= ou SYSTEM_MAIL_FROM= com o nome antigo: troque por Turbo Prospect
    bash deploy/atualizar-servidor.sh        # instalação com PM2/Nginx
    # OU, se você instalou com Docker:
    bash deploy/atualizar-docker.sh

Não precisa da opção `--banco` (não há tabelas novas).

## 4. Conferir
- Abra o site com **Ctrl+F5**: título "Turbo Prospect", logo na tela de login e no menu.
- Celular/PC com o app já instalado: o ícone antigo pode continuar até **desinstalar e instalar de novo** (ou aguarde o aviso "Nova versão disponível → Atualizar").

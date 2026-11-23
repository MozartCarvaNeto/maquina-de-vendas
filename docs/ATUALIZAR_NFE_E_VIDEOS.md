# Atualização: Notas Fiscais (NF-e) dentro do Turbo Prospect + Vídeos tutoriais

## O que mudou
1. **Aba "🧾 Notas Fiscais"** (menu, só para donos/admins da conta): o emissor de NF-e abre dentro do Turbo, com o **mesmo login**. Cada conta tem sua própria empresa, certificado, notas e numeração, totalmente separados.
2. **Plano exclusivo de NF-e**: em **Administração › 🧾 Notas fiscais (NF-e)** você cria os planos (nome, preço, ciclo, limite de notas de produção por mês). O cliente assina na própria aba (cobrança Asaas, o mesmo webhook que você já usa). Plano vencido = modo somente leitura (consulta e baixa XMLs, não emite). Administradores da plataforma emitem sem limite.
3. **Vídeos tutoriais**: em cada página aparece uma miniatura do YouTube com o nome do vídeo, no topo. Você cadastra os links em **Administração › 🎬 Vídeos tutoriais** (só administrador da plataforma). Página sem vídeo não mostra nada.

## Passo 1 — No seu computador
1. Extraia o zip por cima da pasta do projeto, aceitando substituir.
2. Pelo PowerShell/Git, na pasta do projeto: `git add .`, `git commit -m "NF-e e videos tutoriais"`, `git push`.
   (Confira antes que não aparece `.env`, `node_modules` nem `sessions`.)

## Passo 2 — Banco de dados (Supabase)
Opção A (recomendada): abra o Supabase › SQL Editor, cole o conteúdo de `docs/atualizar_banco_nfe.sql` e depois `docs/atualizar_banco_videos.sql` e clique em Run. (Ou cole o `SQL_NOVO_rodar_no_supabase.sql` inteiro: ele é seguro de rodar de novo.)
Opção B: rode o deploy com `--banco` (passo 3), que cria as tabelas sozinho.

## Passo 3 — Servidor (SSH)
    ssh root@177.153.38.127
    cd ~/maquina-de-vendas
    git pull
    bash deploy/instalar-nfe.sh                  # SÓ NA PRIMEIRA VEZ: instala Python e liga o emissor
    bash deploy/atualizar-servidor.sh --banco    # atualiza o sistema principal

O `instalar-nfe.sh` instala o Python, cria o ambiente, gera a chave secreta (grava `NFE_INTERNAL_SECRET` em `backend/.env`), cria o serviço `nfe-emissor` (liga sozinho quando o servidor reinicia) e reinicia o `maquina`. Nas próximas atualizações basta o `atualizar-servidor.sh` (ele também atualiza o emissor).
O Nginx **não precisa de mudança** (a rota `/nfe-app` passa pelo mesmo Node, e o limite de upload já é 110 MB).

## Passo 4 — Conferir
- `systemctl status nfe-emissor` deve mostrar **active (running)**. Erro: `journalctl -u nfe-emissor -n 40`.
- `pm2 logs maquina --lines 30` sem erros novos.
- Entre no sistema (Ctrl+F5) com sua conta administradora: **Administração › Notas fiscais (NF-e)** → crie um plano (ex.: "NF-e Básico", R$ 49,90/mês, 100 notas).
- Entre com uma conta de teste de cliente → aba **Notas Fiscais** → assinar o plano → após o pagamento a aba abre o emissor.
- **Administração › Vídeos tutoriais**: cole um link de YouTube e o nome → abra a página correspondente e veja a miniatura.

## Cuidados (leia)
- **Não foi testado com a SEFAZ real, certificado real, Asaas real nem o seu banco.** Testei o emissor com 35 testes automáticos (simulações) e o restante só quanto à sintaxe. Faça a primeira conta de teste em **Homologação** e emita várias notas de teste antes de produção. Leiaute da NF-e muda em 14/12/2026 (reforma tributária): confirme com seu contador.
- **Cliente só de NF-e** ainda precisa de uma conta no Turbo. Uma conta sem plano do Turbo enxerga todos os módulos; para vender só NF-e, crie um plano Turbo mínimo com poucos módulos e dê a ele.
- **Backup**: as notas ficam em `/var/lib/nfe-emissor` (SQLite + XMLs + certificados criptografados). Inclua essa pasta nos seus backups. Perdendo o `NFE_INTERNAL_SECRET` as sessões se invalidam, mas os dados continuam.
- O plano de NF-e é independente do plano do Turbo (cobrança separada, assinatura Asaas `nfe:<conta>`).
- Vídeos: a miniatura vem do YouTube. O nome do vídeo é digitado por você (não usa chave de API).

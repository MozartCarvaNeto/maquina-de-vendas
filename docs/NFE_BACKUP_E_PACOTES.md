# NF-e: backup, pacotes e espaço

## Onde as notas ficam
No servidor, em `data/contas/<id-da-conta>/` (SQLite `nfe.db` + pasta `xmls/`), em `/var/lib/nfe-emissor`.
**Não** ficam no Supabase. Por isso o backup é essencial.

## Backup (obrigação fiscal: guardar XMLs por 5 anos)
- **Pelo cliente:** no emissor, menu **Backup** → baixa um ZIP com todos os XMLs (por mês e ambiente), DANFEs e cadastros. "Verificar arquivos" repara XMLs faltantes a partir do banco.
- **Pelo servidor (todas as contas):** `bash deploy/backup-notas.sh --instalar` agenda um backup diário às 03:50 (cron), com rotação. Variáveis: `NFE_DADOS`, `BACKUP_NOTAS_DIR`, `BACKUP_NOTAS_DIAS`, `BACKUP_RCLONE_REMOTE` (cópia fora do servidor, recomendado).
- `bash deploy/backup-notas.sh --listar` mostra os backups existentes.

## Como o cliente passa a ter NF-e
1. **Plano de NF-e próprio** (Administração > Notas fiscais): preço, ciclo, notas/mês e espaço (MB).
2. **Plano completo com NF-e inclusa** (Administração > Planos): marcar "Inclui o emissor de NF-e", com notas/mês e espaço.
3. **Liberação manual** pelo administrador (cortesia).
Se a conta tem mais de uma fonte, vale o melhor limite.

## Pacotes avulsos (Administração > Notas fiscais > Pacotes)
- **Notas extras:** somam ao limite mensal e valem só até o fim do mês do pagamento.
- **Espaço (MB):** somam ao espaço do plano e valem `validMonths` meses (padrão 12).
- Compra pelo cliente em **Notas Fiscais > Comprar notas ou espaço** (Asaas; libera sozinho pelo webhook, uma única vez, e só se o valor pago cobrir o pedido).

## Espaço
Espaço base: `NFE_STORAGE_BASE_MB` (padrão 1000 MB) quando o plano não define. Espaço cheio **bloqueia só a emissão**; consultar, baixar e fazer backup continuam sempre liberados. Administrador da plataforma não tem limite.

## Atualizar
`bash deploy/atualizar-servidor.sh --banco` (cria as tabelas `nfe_addons` e `nfe_addon_purchases` e as colunas novas dos planos), depois `bash deploy/backup-notas.sh --instalar`.

#!/usr/bin/env bash
# Backup diário das NOTAS FISCAIS (XMLs, bancos e certificados de todas as contas) no próprio servidor.
# As notas NÃO ficam no Supabase: ficam em /var/lib/nfe-emissor (um banco SQLite + XMLs por conta).
#
# Uso (no servidor, dentro da pasta do projeto):
#     bash deploy/backup-notas.sh              # faz um backup agora
#     bash deploy/backup-notas.sh --instalar   # agenda um backup por dia, às 3h50
#     bash deploy/backup-notas.sh --listar     # mostra os backups guardados
#
# Variáveis opcionais:
#     NFE_DADOS=/var/lib/nfe-emissor        pasta de dados do emissor
#     BACKUP_NOTAS_DIR=/root/backups-notas  onde guardar
#     BACKUP_NOTAS_DIAS=30                  dias de backups diários (o do dia 1º de cada mês nunca é apagado: guarda fiscal de 5 anos)
#     BACKUP_RCLONE_REMOTE=drive:notas      cópia extra FORA do servidor (precisa do rclone configurado)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
DADOS="${NFE_DADOS:-/var/lib/nfe-emissor}"
DESTINO="${BACKUP_NOTAS_DIR:-$HOME/backups-notas}"
DIAS="${BACKUP_NOTAS_DIAS:-30}"

if [ "${1:-}" = "--listar" ]; then ls -lh "$DESTINO" 2>/dev/null || echo "Ainda não há backups em $DESTINO"; exit 0; fi

if [ "${1:-}" = "--instalar" ]; then
  mkdir -p "$DESTINO"
  LINHA="50 3 * * * cd $ROOT && bash deploy/backup-notas.sh >> $DESTINO/backup.log 2>&1"
  ( crontab -l 2>/dev/null | grep -v 'deploy/backup-notas.sh' || true; echo "$LINHA" ) | crontab -
  echo "✅ Backup diário das notas agendado para 03:50 (guarda $DIAS dias + 1 por mês) em $DESTINO."
  echo "   Fazendo o primeiro agora para testar..."
fi

[ -d "$DADOS/contas" ] || { echo "❌ Pasta $DADOS/contas não existe. Informe NFE_DADOS=... se o emissor usa outro caminho." >&2; exit 1; }
umask 077
mkdir -p "$DESTINO"
STAMP="$(date +%F_%H%M)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1) cópia CONSISTENTE de cada banco SQLite (nunca copie o arquivo "no braço" com o sistema usando)
mkdir -p "$TMP/contas"
for conta in "$DADOS"/contas/*/; do
  id="$(basename "$conta")"
  mkdir -p "$TMP/contas/$id"
  if [ -f "$conta/nfe.db" ]; then
    python3 - "$conta/nfe.db" "$TMP/contas/$id/nfe.db" <<'PY'
import sqlite3, sys
src = sqlite3.connect(sys.argv[1]); dst = sqlite3.connect(sys.argv[2])
src.backup(dst); dst.close(); src.close()
PY
  fi
  for sub in xmls certs; do [ -d "$conta/$sub" ] && cp -a "$conta/$sub" "$TMP/contas/$id/$sub"; done
  for f in "$conta"/*; do case "$f" in */nfe.db|*/nfe.db-*|*/xmls|*/certs) ;; *) [ -f "$f" ] && cp -a "$f" "$TMP/contas/$id/" ;; esac; done
done

# 2) compacta e confere
ARQ="$DESTINO/notas_$STAMP.tar.gz"
tar -C "$TMP" -czf "$ARQ" contas
tar -tzf "$ARQ" >/dev/null
chmod 600 "$ARQ"
echo "✅ $(date '+%F %T') backup das notas: $ARQ ($(du -h "$ARQ" | cut -f1))"

# 3) limpeza: apaga diários antigos, mas guarda sempre o primeiro backup de cada mês
find "$DESTINO" -name 'notas_*.tar.gz' -mtime +"$DIAS" ! -name 'notas_????-??-01_*' -delete

# 4) cópia fora do servidor (opcional)
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ] && command -v rclone >/dev/null 2>&1; then
  rclone copy "$ARQ" "$BACKUP_RCLONE_REMOTE" && echo "☁️  copiado para $BACKUP_RCLONE_REMOTE"
fi

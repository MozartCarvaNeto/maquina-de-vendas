#!/usr/bin/env bash
# Backup do banco de dados (Supabase/Postgres) para o próprio servidor.
#
# Uso (no servidor, dentro da pasta do projeto):
#     bash deploy/backup-banco.sh              # faz um backup agora
#     bash deploy/backup-banco.sh --instalar   # agenda um backup por dia, às 3h30
#     bash deploy/backup-banco.sh --listar     # mostra os backups guardados
#
# Opções (variáveis de ambiente, opcionais):
#     BACKUP_DIR=/root/backups-maquina   pasta dos backups
#     BACKUP_DIAS=14                     quantos dias guardar
#     BACKUP_RCLONE_REMOTE=drive:backups cópia extra fora do servidor (precisa do rclone configurado)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups-maquina}"
BACKUP_DIAS="${BACKUP_DIAS:-14}"

if [ "${1:-}" = "--listar" ]; then
  ls -lh "$BACKUP_DIR" 2>/dev/null || echo "Ainda não há backups em $BACKUP_DIR"
  exit 0
fi

if [ "${1:-}" = "--instalar" ]; then
  LINHA="30 3 * * * cd $ROOT && bash deploy/backup-banco.sh >> $BACKUP_DIR/backup.log 2>&1"
  mkdir -p "$BACKUP_DIR"
  ( crontab -l 2>/dev/null | grep -v 'deploy/backup-banco.sh' || true; echo "$LINHA" ) | crontab -
  echo "✅ Backup diário agendado para 03:30. Guardamos $BACKUP_DIAS dias em $BACKUP_DIR."
  echo "   Fazendo o primeiro backup agora para testar..."
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "❌ pg_dump não está instalado. Rode: apt-get update && apt-get install -y postgresql-client" >&2
  exit 1
fi

# Lê a DATABASE_URL do .env do backend (sem exibir a senha).
ENV_FILE="$ROOT/backend/.env"
URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
if [ -z "$URL" ]; then echo "❌ DATABASE_URL não encontrada em $ENV_FILE" >&2; exit 1; fi
# O Prisma aceita parâmetros (pgbouncer, connection_limit) que o pg_dump não entende: tira todos, menos sslmode.
BASE="${URL%%\?*}"
SSL="$(echo "$URL" | grep -o 'sslmode=[a-z-]*' | head -1 || true)"
if [ -n "$SSL" ]; then BASE="$BASE?$SSL"; fi

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y-%m-%d_%H%M)"
OUT="$BACKUP_DIR/banco_$STAMP.sql.gz"
TMP="$OUT.parcial"

echo "🗄️  Fazendo o backup do banco..."
if ! pg_dump --no-owner --no-privileges --clean --if-exists "$BASE" 2>"$BACKUP_DIR/ultimo-erro.txt" | gzip -9 > "$TMP"; then
  echo "❌ O backup falhou: $(tail -3 "$BACKUP_DIR/ultimo-erro.txt")" >&2
  if grep -qi 'version mismatch' "$BACKUP_DIR/ultimo-erro.txt"; then
    echo "   O pg_dump do servidor é mais antigo que o banco. Instale um mais novo: apt-get install -y postgresql-client-17 (ou 16)." >&2
  fi
  rm -f "$TMP"; exit 1
fi
SIZE="$(stat -c %s "$TMP")"
if [ "$SIZE" -lt 2000 ]; then echo "❌ Backup suspeito (só $SIZE bytes). Não foi guardado." >&2; rm -f "$TMP"; exit 1; fi
mv "$TMP" "$OUT"
echo "✅ Backup salvo: $OUT ($(du -h "$OUT" | cut -f1))"

# Anexos enviados pelos usuários (se existirem).
if [ -d "$ROOT/backend/uploads" ] && [ -n "$(ls -A "$ROOT/backend/uploads" 2>/dev/null)" ]; then
  tar -czf "$BACKUP_DIR/uploads_$STAMP.tar.gz" -C "$ROOT/backend" uploads && echo "✅ Anexos salvos: uploads_$STAMP.tar.gz"
fi

# Apaga os mais antigos.
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'banco_*.sql.gz' -o -name 'uploads_*.tar.gz' \) -mtime +"$BACKUP_DIAS" -delete

# Cópia fora do servidor (opcional).
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  if command -v rclone >/dev/null 2>&1; then
    rclone copy "$OUT" "$BACKUP_RCLONE_REMOTE" && echo "☁️  Cópia enviada para $BACKUP_RCLONE_REMOTE"
  else
    echo "⚠️  BACKUP_RCLONE_REMOTE definido, mas o rclone não está instalado." >&2
  fi
fi

#!/usr/bin/env bash
# Atualiza o sistema (instalação com Docker) depois de enviar mudanças ao GitHub.
#   bash deploy/atualizar-docker.sh            # atualização normal
#   bash deploy/atualizar-docker.sh --banco    # também atualiza as tabelas do banco
set -e
cd "$(dirname "$0")/.."
echo "⬇️  Baixando a versão nova do GitHub..."
git pull
echo "🏗️  Reconstruindo e reiniciando (1-3 minutos)..."
docker compose up -d --build
if [ "$1" = "--banco" ]; then
  echo "🗄️  Atualizando as tabelas do banco..."
  docker compose exec app npx prisma db push
fi
docker image prune -f >/dev/null 2>&1 || true
echo "✅ Pronto! Logs: docker compose logs -f app --tail 40"

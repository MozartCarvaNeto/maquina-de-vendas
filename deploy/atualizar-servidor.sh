#!/usr/bin/env bash
# Atualiza o sistema NO SERVIDOR depois que você enviou mudanças ao GitHub.
#
# Uso (no servidor, dentro da pasta do projeto):
#     bash deploy/atualizar-servidor.sh            # atualização normal
#     bash deploy/atualizar-servidor.sh --banco    # também atualiza as tabelas do banco
set -e
cd "$(dirname "$0")/.."

echo "⬇️  1/5 Baixando a versão nova do GitHub..."
git pull

echo "📦 2/5 Atualizando o backend..."
cd backend
npm install
npx prisma generate

if [ "$1" = "--banco" ]; then
  echo "🗄️  Atualizando as tabelas do banco (prisma db push)..."
  npx prisma db push
fi

echo "🖥️  3/5 Compilando o frontend (pode levar 1-2 minutos)..."
cd ../frontend
npm install
npm run build

echo "🔄 4/5 Reiniciando o sistema..."
pm2 restart maquina

echo "✅ 5/5 Pronto! Veja se está tudo certo com:  pm2 logs maquina --lines 40"

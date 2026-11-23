#!/usr/bin/env bash
# Instala (UMA vez) o emissor de NF-e no servidor: Python + serviço que liga sozinho com o servidor.
# Uso, dentro da pasta do projeto:   bash deploy/instalar-nfe.sh
# Pode rodar de novo sem medo: ele só completa o que faltar.
set -e
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
EMISSOR="$RAIZ/nfe-emissor"
VENV="$EMISSOR/.venv"
DADOS="/var/lib/nfe-emissor"
ENVSVC="/etc/nfe-emissor.env"
ENVBACK="$RAIZ/backend/.env"

if [ "$(id -u)" -ne 0 ]; then echo "❌ Rode como administrador (root) ou com sudo."; exit 1; fi
[ -d "$EMISSOR" ] || { echo "❌ Pasta nfe-emissor não encontrada. Rode 'git pull' primeiro."; exit 1; }
[ -f "$ENVBACK" ] || { echo "❌ Não achei $ENVBACK (o .env do backend)."; exit 1; }

echo "🐍 1/5 Instalando o Python e dependências do sistema..."
apt-get update -y
apt-get install -y python3 python3-venv python3-pip libxml2-dev libxslt1-dev

echo "📦 2/5 Criando o ambiente do emissor e instalando as bibliotecas..."
[ -d "$VENV" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install --upgrade pip
"$VENV/bin/pip" install -r "$EMISSOR/requirements.txt"

echo "🔑 3/5 Configurando a chave secreta compartilhada..."
SEGREDO="$(grep -E '^NFE_INTERNAL_SECRET=' "$ENVBACK" | tail -1 | cut -d= -f2- || true)"
if [ -z "$SEGREDO" ]; then
  SEGREDO="$(python3 -c 'import secrets;print(secrets.token_hex(32))')"
  printf '\n# Emissor de NF-e (chave compartilhada com o serviço nfe-emissor)\nNFE_INTERNAL_SECRET=%s\n' "$SEGREDO" >> "$ENVBACK"
  echo "   chave criada no backend/.env"
fi
mkdir -p "$DADOS"; chmod 700 "$DADOS"
if [ ! -f "$ENVSVC" ]; then
  umask 077
  cat > "$ENVSVC" <<ENV
NFE_INTERNAL_SECRET=$SEGREDO
BEHIND_PROXY=1
NFE_PREFIXO=/nfe-app
COOKIE_SECURE=1
DATA_DIR=$DADOS
ENV
else
  # mantém o serviço sempre com a MESMA chave do backend
  sed -i "s|^NFE_INTERNAL_SECRET=.*|NFE_INTERNAL_SECRET=$SEGREDO|" "$ENVSVC"
fi
chmod 600 "$ENVSVC"

echo "⚙️  4/5 Criando o serviço que liga sozinho (nfe-emissor)..."
cat > /etc/systemd/system/nfe-emissor.service <<UNIT
[Unit]
Description=Emissor de NF-e (Turbo Prospect)
After=network.target

[Service]
Type=simple
WorkingDirectory=$EMISSOR
EnvironmentFile=$ENVSVC
ExecStart=$VENV/bin/gunicorn --workers 2 --timeout 120 --bind 127.0.0.1:5001 wsgi:app
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable nfe-emissor
systemctl restart nfe-emissor

echo "🔄 5/5 Reiniciando o sistema principal para ler a chave..."
if command -v pm2 >/dev/null 2>&1; then pm2 restart maquina --update-env || true; fi

sleep 2
if curl -fsS -o /dev/null http://127.0.0.1:5001/ 2>/dev/null || systemctl is-active --quiet nfe-emissor; then
  echo "✅ Emissor de NF-e instalado e rodando. Veja: systemctl status nfe-emissor"
else
  echo "⚠️  O serviço não parece ativo. Veja o motivo com: journalctl -u nfe-emissor -n 40"
fi
echo "📁 Dados das notas (faça backup): $DADOS"

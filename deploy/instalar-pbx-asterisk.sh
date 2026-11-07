#!/usr/bin/env bash
# Preparação ÚNICA do Asterisk para o PBX do Turbo Prospect (URA, filas, gravação, IA).
# Rode no servidor (VPS), como administrador:   sudo bash instalar-pbx-asterisk.sh [usuario_do_sistema]
# "usuario_do_sistema" é quem roda o pm2 (padrão: o usuário que chamou o sudo; se for root, deixe root).
set -euo pipefail

APP_USER="${1:-${SUDO_USER:-root}}"
CONF=/etc/asterisk
SOUNDS=/var/lib/asterisk/sounds/turbo
RECS=/var/spool/asterisk/turbo-recordings
OUTGOING=/var/spool/asterisk/outgoing

if [ "$(id -u)" -ne 0 ]; then echo "Rode com sudo."; exit 1; fi

if ! command -v asterisk >/dev/null 2>&1; then
  echo "▶ Instalando o Asterisk..."
  apt-get update -y && apt-get install -y asterisk ffmpeg
fi

echo "▶ Conferindo módulos necessários..."
VER="$(asterisk -V 2>/dev/null || true)"; echo "   $VER"
for m in res_pjsip.so res_http_websocket.so app_queue.so app_mixmonitor.so app_confbridge.so func_curl.so app_audiosocket.so; do
  if [ ! -f "/usr/lib/asterisk/modules/$m" ] && [ ! -f "/usr/lib64/asterisk/modules/$m" ]; then
    echo "   ⚠️  Módulo $m não encontrado. "$( [ "$m" = app_audiosocket.so ] && echo 'A IA pelo Asterisk precisa do Asterisk 18.12+ ou 20 (AudioSocket).' || echo 'Instale o pacote completo: apt install asterisk asterisk-modules' )
  fi
done

echo "▶ Criando pastas (áudios, gravações) e dando acesso ao sistema ($APP_USER)..."
mkdir -p "$SOUNDS" "$RECS" "$OUTGOING"
chown -R asterisk:asterisk "$SOUNDS" "$RECS" "$OUTGOING"
chmod -R 2775 "$SOUNDS" "$RECS" "$OUTGOING"
chmod g+w "$CONF"
if [ "$APP_USER" != "root" ]; then usermod -aG asterisk "$APP_USER"; fi

echo "▶ Ligando as configurações do Turbo Prospect no Asterisk..."
add_line() { # arquivo, linha
  touch "$CONF/$1"; grep -qxF "$2" "$CONF/$1" || echo "$2" >> "$CONF/$1"
}
add_line pjsip.conf '#tryinclude pjsip_turbo_*.conf'
add_line extensions.conf '#tryinclude extensions_turbo_*.conf'
add_line queues.conf '#tryinclude queues_turbo_*.conf'
add_line musiconhold.conf '#tryinclude musiconhold_turbo_*.conf'

if ! grep -q '^bindport=8088' "$CONF/http.conf" 2>/dev/null; then
  cat >> "$CONF/http.conf" <<'HTTP'

[general]
enabled=yes
bindaddr=127.0.0.1
bindport=8088
HTTP
fi
# gravações e avisos dependem do func_curl, que só fala com endereços locais por padrão — nada a mudar.

systemctl enable asterisk >/dev/null 2>&1 || true
systemctl restart asterisk
sleep 2
echo
echo "✅ Pronto. Agora, no portal: Telefonia PBX → Instalação e IA → \"Aplicar no Asterisk\"."
if [ "$APP_USER" != "root" ]; then echo "   (Reinicie o sistema: pm2 restart maquina — para ele enxergar o novo grupo.)"; fi
asterisk -rx "core show version" || true

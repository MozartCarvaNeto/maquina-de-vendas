# Imagem dentro do e-mail dos disparos (texto em cima ou embaixo)

## O que mudou
- Em Disparos > Novo disparo > canal **E-mail** há o campo **"Imagem do e-mail"**: a imagem aparece dentro da mensagem, em largura total (como e-mails comerciais), e não como arquivo anexado.
- **Posição do texto:** escolha "Imagem em cima e texto embaixo" ou "Texto em cima e imagem embaixo".
- A foto é reduzida automaticamente no navegador (largura máx. 1280 px) para ir leve.
- O campo "Anexos" continua existindo para PDF, Word etc.
- Quebras de linha do texto digitado agora aparecem no e-mail.
- Funciona com SMTP, Resend, SendGrid e e-mail nativo. O e-mail da Twilio (comms) não aceita imagem/anexo.

## Instalar
1. Descompacte o zip por cima do projeto (mesmas pastas) e recompile o frontend como nas atualizações anteriores.
2. `pm2 restart maquina`
3. Não precisa mexer no banco.

## Se ainda der erro 413 ("Request Entity Too Large") — o seu log mostrou isso
Quem barrou o envio foi o servidor web (nginx), que por padrão aceita só 1 MB. No VPS:
1. `grep -rn client_max_body_size /etc/nginx/` (se não aparecer nada, o limite é 1 MB)
2. Edite o arquivo do seu site (ex.: `sudo nano /etc/nginx/sites-available/default` ou o do seu domínio) e dentro de `server { ... }` coloque: `client_max_body_size 110m;`
3. `sudo nginx -t && sudo systemctl reload nginx`

Se usar Caddy ou Docker, avise qual é para eu ajustar.

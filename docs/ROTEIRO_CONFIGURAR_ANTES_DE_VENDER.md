# Roteiro: configurar tudo antes de começar a vender

Marque cada item só depois de **testar de verdade** (o código dos módulos de telefonia foi testado com simuladores, não com operadora real).
Comandos no servidor: `cd /root/maquina-de-vendas`. Logs: `pm2 logs maquina --lines 60`.

## Ordem recomendada (do que destrava mais para o que destrava menos)
1. Base do servidor (`.env`, domínio, HTTPS, backups)
2. E-mail do sistema (recuperação de senha, avisos)
3. Cobrança (Asaas) — sem isso você não recebe
4. Planos e módulos à venda
5. NF-e (já em produção; falta backup e pacotes)
6. SMS próprio (gateway SMPP)
7. Voz: tronco SIP + Asterisk
8. PBX (URA, filas, rotas) e IA de voz
9. E-mail em massa dos clientes (domínio, SPF/DKIM/DMARC)
10. RCS
11. Segurança, termos legais, teste final

O que você precisa **contratar fora do sistema** (comece cedo, alguns levam dias):
| Item | O que pedir | Prazo típico |
|---|---|---|
| Fornecedor SMPP (SMS) | servidor, porta, usuário, senha, SMS/segundo, remetente liberado, relatório de entrega, custo por SMS | dias (exige cadastro da empresa e do remetente) |
| Tronco SIP (voz) | servidor, porta, usuário, senha, se exige registro, número(s) DID, custo por minuto | dias |
| Agente RCS | cadastro da marca no provedor (Twilio, Zenvia, Infobip…) | dias a semanas |
| Asaas produção | conta aprovada | 1–3 dias |
| E-mail transacional (opcional) | SendGrid ou Resend | minutos |

---

## 1. Base do servidor
1. `nano backend/.env` e confira (modelo em `backend/env.example`):
   - `BACKEND_PUBLIC_URL` e `FRONTEND_URL` = `https://seudominio` (https, sem barra no fim).
   - `SUPERADMIN_EMAILS` = seu e-mail.
   - `JWT_SECRET` e `SETTINGS_ENCRYPTION_KEY` (64 hex) longos e **nunca mais trocados** depois de ter clientes (trocar a chave de criptografia invalida as chaves salvas em Configurações).
   - `REGISTRATION_MODE=approval` (recomendado).
2. Salvar e `pm2 restart maquina --update-env`.
3. Conferir: `curl -s https://seudominio/api/health` (ou abrir o site) e `pm2 status` (deve haver **1 processo** `maquina`, sem cluster — o SMPP exige processo único).
4. Backup do banco: `bash deploy/backup-banco.sh` e agende no cron. Backup das notas: `bash deploy/backup-notas.sh --instalar`.

## 2. E-mail do sistema (hoje dá erro 535 do Gmail)
Menu **Administração > E-mail do sistema**.
**Opção A – Gmail (rápida, serve para começar):**
1. Conta Google > Segurança > ative a **verificação em 2 etapas**.
2. Segurança > **Senhas de app** > crie uma (16 letras). Cole **sem espaços**.
3. No painel: servidor `smtp.gmail.com`, porta `587`, usuário = e-mail completo, senha = a senha de app (não a senha normal).
4. Clique em **Enviar teste**. Erro 535 = senha de app errada ou 2 etapas desligada.
5. Limite do Gmail: poucos envios por dia. Serve só para recuperação de senha/avisos.
**Opção B – SendGrid/Resend (recomendada para vender):** crie a chave de API, verifique o remetente/domínio, preencha no painel, teste.
Teste final: "Esqueci minha senha" com um e-mail de verdade → chegou? Caixa de entrada ou spam?

## 3. Cobrança (Asaas)
Detalhe completo: `docs/GUIA_PUBLICAR_ONLINE.md` parte F.5.
1. Comece em `ASAAS_ENV=sandbox`. Gere a chave de API no Asaas.
2. `.env`: `ASAAS_API_KEY`, `ASAAS_ENV`, `ASAAS_WEBHOOK_TOKEN` (32+ caracteres inventados).
3. Asaas > Integrações > Webhooks > novo: URL `https://seudominio/api/webhooks/asaas`, **mesmo token**, eventos de cobrança.
4. `pm2 restart maquina --update-env`. Faça uma assinatura de teste e pague no sandbox: a conta deve liberar sozinha.
5. Para produção: troque a chave e `ASAAS_ENV=production`, **cadastre o webhook de novo no painel de produção** e repita o teste com um valor pequeno real.
6. Se um pagamento não liberar: Asaas > histórico de envios do webhook; painel de planos tem "+30 dias" como quebra-galho.

## 4. Planos e módulos
**Administração > Planos**: crie os planos (preço, ciclo, limites, módulos). Novidade: caixa **"Inclui o emissor de NF-e"** com notas/mês e espaço. Módulos de telefonia/gateway só aparecem para quem o plano libera. Defina quais são públicos.
Checklist: crie uma conta de teste, atribua cada plano e confira o que ela vê no menu.

## 5. NF-e
1. `bash deploy/backup-notas.sh --instalar` e rode uma vez agora.
2. **Administração > Notas fiscais**: crie planos de NF-e (se for vender à parte) e os **pacotes** (+100 MB, +200 MB, +500 MB, +100 notas…).
3. Teste de compra de pacote no Asaas sandbox: conferir que o espaço aumenta.
4. Opcional: cópia fora do servidor (`BACKUP_RCLONE_REMOTE`).

## 6. SMS próprio (gateway SMPP)
Detalhe: `docs/ATUALIZAR_GATEWAY_TELECOM.md`.
1. Contrate o SMPP (tabela acima).
2. Libere a **saída** da porta SMPP no firewall do VPS (2775/2776 ou a que o fornecedor der). Teste do servidor: `nc -vz HOST PORTA`.
3. Menu **Gateway de telecom > Fornecedores > Cadastrar** (host, porta, usuário, senha, limite/segundo, prioridade, custo). Deve ficar 🟢 Conectado; se der erro, a mensagem diz o motivo.
4. Aba **Enviar e acompanhar**: envie ao seu celular; status deve chegar a **Entregue**.
5. Aba **💳 Saldo** (só administrador): tarifa por SMS e margem; ligue o pré-pago nas contas de clientes; recarregue saldo de teste.
6. Marque **"Usar este gateway nos Disparos de SMS"**.
7. Aba **API**: crie uma chave e teste `POST /api/v1/sms/messages`.
8. Responda "SAIR" a um SMS de teste: o contato deve ser descadastrado.
Atenção: remetente (Sender ID) e conteúdo costumam ter regras das operadoras; combine com o fornecedor antes de disparar em massa.

## 7. Voz: tronco SIP + Asterisk
Detalhe: `docs/ATUALIZAR_TELEFONE_SIP.md`.
1. `sudo apt install asterisk` (versão 18.12+ ou 20).
2. **Gateway de telecom > Voz (SIP)**: cadastre o tronco e clique **Gerar arquivos**. Baixe `pjsip_turbo.conf` e `extensions_turbo.conf` para `/etc/asterisk/`.
3. Ao final de `/etc/asterisk/pjsip.conf`: `#include pjsip_turbo.conf`; de `extensions.conf`: `#include extensions_turbo.conf`; `sudo chmod 640 /etc/asterisk/pjsip_turbo.conf`.
4. `/etc/asterisk/http.conf`: `enabled=yes`, `bindaddr=127.0.0.1`, `bindport=8088`.
5. nginx: bloco `location /asterisk-ws` (ver o doc; no seu servidor o `proxy_pass` do site usa `127.0.0.1`), `sudo nginx -t && sudo systemctl reload nginx`.
6. Firewall: UDP 10000–20000 (áudio) + portas SIP do fornecedor.
7. `sudo systemctl restart asterisk`; `sudo asterisk -rx "pjsip show registrations"` → **Registered**.
8. Menu **Telefone (ligações)**: 🟢 Pronto → ligue para o seu celular, depois ligue do celular para o seu DID.
Sem áudio = firewall UDP/NAT quase sempre.

## 8. PBX e IA de voz
Detalhe: `docs/ATUALIZAR_PBX_NATIVO.md`. **Configuração do PBX é só do administrador**; clientes veem o catálogo de serviços e usam os recursos que o plano libera.
1. `sudo bash deploy/instalar-pbx-asterisk.sh` (uma vez) e `pm2 restart maquina`.
2. **Telefonia PBX**: Áudios (saudação, música) → Filas → URA → Rotas de entrada → **Aplicar no Asterisk**.
3. Teste: ligue para o seu número de outro celular; confira em **Chamadas e gravações**.
4. IA: chave do Gemini em Configurações > Inteligência Artificial; em Configurações > Telefonia da IA escolha **Asterisk**; faça uma ligação de teste pelo Agente de IA.
5. Para cada cliente, use "agir em nome do cliente" para configurar por ele.

## 9. E-mail em massa dos clientes (domínio próprio)
1. Configurações > E-mail: escolha SMTP, Resend, SendGrid ou **E-mail nativo**.
2. Domínio próprio: o sistema gera DKIM (seletor `mdv`) e mostra os registros **SPF, DKIM e DMARC** para você criar no DNS (Registro.br/Cloudflare). Clique em verificar até ficarem verdes.
3. Muitos provedores de VPS bloqueiam a porta 25: se o envio nativo falhar, use Resend/SendGrid.
4. Aqueça o domínio: poucos envios por dia no começo.
5. Teste enviando para Gmail e Outlook e olhando o spam; confira o link de descadastro.

## 10. RCS
Detalhe: `docs/ATUALIZAR_RCS.md`. Sem **agente verificado** não sai nada.
1. Peça o agente no provedor (Twilio/Zenvia/Infobip/Sinch/Pontaltech).
2. Configurações > RCS: preencha o provedor; **Enviar RCS de teste** para o seu celular.
3. Não há relatório de entregue/lido nem tratamento de respostas ainda. Os provedores "Outra empresa" não foram testados contra APIs reais.

## 11. Segurança e legal
- Troque qualquer chave que já vazou (guia C1).
- `ufw status`: só 22, 80, 443, UDP 10000–20000 e o que o SIP pedir.
- **Administração > Legal**: termos de uso e privacidade (LGPD) publicados.
- Cadastre WhatsApp: use números separados dos pessoais; comece com volume baixo.
- `pm2 save` e `pm2 startup` para subir sozinho após reinício.

## 12. Teste final (30 min)
Cadastro novo → aprovação → plano → pagamento sandbox → acesso liberado → recuperar senha → SMS entregue → ligação saída/entrada → NF-e de homologação + backup baixado → compra de pacote → atualizar servidor sem perder nada.

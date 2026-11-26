# Telefonia: configuração só do superadmin; assinante usa e paga

## O que mudou
- **Backend** (`pbx.routes.js`): URA, filas, rotas de entrada, áudios, configurações e "Aplicar no Asterisk" exigem `requirePlatformAdmin`. Já eram só do superadmin: fornecedores SMPP, troncos SIP, números (DID), servidor Asterisk, motores de voz, regras de cobrança.
- **Agir em nome do cliente**: o superadmin escolhe uma conta na tela PBX; o front manda `x-act-as-account` (ou `?accountId=`) e `middlewares/actAsAccount.js` troca `req.userId` só para ele. Para assinante o parâmetro é ignorado.
- **Vitrine** `GET /api/pbx/catalog`: tarifas (SMS, voz entrada/saída, número, WhatsApp), o que o plano inclui, saldo e números da conta.
- **Frontend**: menu do superadmin mostra "Telefonia PBX (URA e filas)" e "Gateway de telecom"; o assinante vê "Minhas chamadas e tarifas" e "SMS, saldo e API". Na tela PBX o assinante só tem Serviços e tarifas, Ao vivo e Chamadas/gravações.

## Como cobrar (já existente, configurado pelo superadmin)
Planos (minutos/SMS/números inclusos) em Administração → Planos; saldo pré-pago e tarifas por cliente no Gateway → Saldo; mensalidade de número em Números (admin).

## Limites desta entrega
Escolha de fornecedor por assinante (Twilio x própria) com tarifa distinta por opção **não** foi criada: hoje a plataforma define o fornecedor e a tarifa por conta. Sem mudança de banco (sem `--banco`).

## Deploy
`git add -A && git commit -m "Telefonia só superadmin" && git push`, depois no servidor `bash deploy/atualizar-servidor.sh`. Teste: `node backend/tests/telefoniaAdmin.test.js`.

# Gateway de telecom nativo (SMS próprio + API + base de voz)

## O que é e o que NÃO é
Empresas como Twilio, Zenvia, Infobip, Sinch e Pontaltech fazem duas coisas: (1) têm **contratos e conexões diretas com as operadoras** e (2) oferecem **software** (fila, API, relatórios, cobrança). O item (2) agora é do seu portal. O item (1) nenhum código substitui: alguém precisa "puxar o fio" até as operadoras. A boa notícia é que esse fio é padronizado: **SMPP** para SMS e **SIP** para voz. Você contrata esse acesso no **atacado** (de operadoras ou de empresas de telecom que vendem SMPP/SIP) e pode trocar de fornecedor quando quiser, sem mexer no sistema.

## O que está incluído
**SMS (completo, testado em ambiente simulado):**
- Cliente SMPP 3.4 próprio: login, janela de envios, limite por segundo, reconexão automática, SMS longo em várias partes, acentos (GSM/UCS-2, com opção de remover acentos para gastar menos).
- Vários fornecedores com prioridade, custo e prefixo de destino; se um cair ou estourar o limite, troca sozinho para o próximo (número inválido não troca).
- Relatório de entrega (entregue / não entregue) por mensagem e por parte.
- Respostas dos clientes recebidas; "SAIR/PARAR/STOP/CANCELAR…" marca o contato como descadastrado automaticamente.
- API própria: `POST /api/v1/sms/messages` com chave (como uma CPaaS), consulta de status.
- Consumo: custo, valor cobrado e margem por dia; preço por parte configurável.
- Opção "Usar este gateway nos Disparos de SMS" (no lugar da Twilio).
- Menu **📡 Gateway de telecom** (módulo "gateway" nos planos; plano Completo já inclui).

**Voz:** veja `docs/ATUALIZAR_TELEFONE_SIP.md` (telefone no navegador, ramais e histórico).

## Instalar
1. No Supabase > SQL Editor, rode `docs/atualizar_banco_gateway_telecom.sql` (cria 4 tabelas; pode repetir sem problema).
2. Descompacte o zip por cima do projeto, no servidor rode `cd backend && npx prisma generate`, recompile o frontend como nas outras atualizações e `pm2 restart maquina`.
3. Importante: rode o sistema como **um único processo** (`pm2 restart maquina`, sem modo cluster), pois cada fornecedor mantém uma única conexão SMPP.
4. Libere a saída da porta SMPP do fornecedor (geralmente 2775 ou 2776) no firewall do VPS, se houver bloqueio de saída.

## Como começar com SMS
1. Contrate acesso **SMPP** (peça: servidor, porta, usuário, senha, limite de envios por segundo, remetente liberado, se aceita relatório de entrega e custo por SMS). Normalmente exige cadastro da empresa e do remetente.
2. Menu Gateway de telecom > Fornecedores > Cadastrar. Em instantes aparece 🟢 Conectado (se aparecer erro, a mensagem diz o motivo, ex.: senha recusada).
3. Aba "Enviar e acompanhar": mande um SMS para o seu celular e veja o status mudar para Entregue.
4. Para os Disparos: marque "Usar este gateway nos Disparos de SMS".
5. Para sistemas externos: aba API > Criar chave.

## Como começar com voz (Asterisk)
1. No VPS (Ubuntu): `sudo apt install asterisk`.
2. Aba Voz (SIP): cadastre o tronco com os dados do fornecedor de voz e clique em "Gerar arquivos"; baixe os dois arquivos para `/etc/asterisk/`.
3. No final de `/etc/asterisk/pjsip.conf` acrescente `#include pjsip_turbo.conf` e no final de `extensions.conf` acrescente `#include extensions_turbo.conf`. Proteja o arquivo (tem senha): `sudo chmod 640 /etc/asterisk/pjsip_turbo.conf`.
4. `sudo asterisk -rx "core reload"` e confira: `sudo asterisk -rx "pjsip show registrations"` (deve estar Registered).
5. Libere no firewall as portas SIP (5060) e de áudio RTP (10000–20000 UDP) conforme o fornecedor.

## Cuidados legais e de reputação (importante)
SMS em massa no Brasil exige remetente cadastrado nas operadoras, mensagens com opção de sair e envio só para quem consentiu (LGPD). Operadoras bloqueiam remetentes que geram reclamação. Comece com volumes pequenos.

## Limites desta versão
- Testado só contra servidor SMPP simulado (login, SMS longo, entrega, resposta, queda e reconexão, troca de fornecedor). Cada operadora tem pequenas diferenças: se algo falhar, a tela mostra o código de erro do fornecedor.
- O envio fica salvo no banco, então reiniciar o sistema não perde a fila; mensagens "enviadas ao fornecedor" sem relatório de entrega ficam como "Enviado ao fornecedor".
- Não há saldo pré-pago (crédito) por cliente: há extrato de consumo e preço por parte; bloqueio por saldo é uma etapa futura.
- Voz: só a configuração do Asterisk; softphone no navegador e integração com a IA ficam para a próxima etapa.

# Receber áudio/foto no Chat + e-mail de recuperação de senha

## 1) Áudio e foto recebidos não baixavam
**Causa (confirmada nos relatos públicos da biblioteca do WhatsApp):** a atualização do WhatsApp Web de julho/2026 mudou o identificador interno das mensagens. A biblioteca (whatsapp-web.js 1.34.7) passou a falhar em **todo** download de anexo, com o erro opaco **"r"**, que foi o "Motivo: r" que apareceu no seu print. Como o identificador não era lido, o botão "Tentar baixar de novo" também não aparecia.

**O que mudou**
- O sistema agora lê o identificador no formato novo (e reconstrói quando falta).
- Se a biblioteca ainda falhar, ele baixa **direto pela página do WhatsApp Web** (plano B). Se também falhar, a mensagem mostra o **erro real** em vez de "r".
- O botão **🔁 Tentar baixar de novo** passa a aparecer nas mensagens novas que falharem.
- Mensagens que já falharam antes **não têm** o botão (o código delas não foi guardado): peça para o contato reenviar.

**Se ainda falhar**, me mande o texto do "Motivo: …" que aparece na mensagem. O WhatsApp muda essas peças internas com frequência, e o motivo mostra qual delas.

## 2) E-mail de "Esqueci minha senha" não chegava
**Causa:** o sistema só tentava o SMTP do sistema (`SYSTEM_SMTP_*` no `.env`) e o e-mail configurado na conta de **quem pediu a senha**. Um cliente ou usuário sem e-mail configurado ficava sem caminho: o envio falhava em silêncio (a tela diz "se o e-mail existir, você receberá" para não revelar quem é cliente).

**O que mudou**
- Nova ordem: (1) SMTP do sistema; (2) e-mail da conta do usuário; (3) **e-mail configurado na sua conta de administrador** (Configurações → E-mail). Se você já envia e-mail por ela, a recuperação de senha de todos passa a sair por ali.
- Nova aba **Administração → ✉️ E-mail do sistema**: envia um e-mail de teste e mostra qual caminho funcionou ou o erro de cada um. Ela avisa também se `FRONTEND_URL` do `.env` estiver apontando para localhost (o link do e-mail ficaria errado).
- Cada falha de envio agora fica registrada no log do servidor.

**O que você precisa conferir**
1. Em Configurações → E-mail da sua conta de administrador, tenha um provedor funcionando (use o teste de lá).
2. No `.env` do servidor: `FRONTEND_URL=https://seu-endereco` e `SUPERADMIN_EMAILS=seu-email-de-admin`.
3. Abra **Administração → E-mail do sistema**, envie o teste para você e veja o resultado.
4. Peça a recuperação de senha de novo. O limite é de 3 pedidos por hora por e-mail.

## Instalação
Copie as pastas `backend` e `frontend` do zip por cima do projeto, reinicie o backend, gere o frontend de novo (`npm run build`) e abra o sistema em aba anônima. Não precisa de SQL.

## Testado e não testado
Testado com simulação: leitura do identificador novo, o plano B de download, a mensagem com o motivo, o botão de retentativa e a ordem de envio de e-mail (cliente sem e-mail → sai pela conta do administrador; tudo falhando → erro detalhado). Não testado com o WhatsApp e o provedor de e-mail reais.

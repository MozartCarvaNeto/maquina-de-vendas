# Recuperação de senha automática (e-mail enviado pelo Firebase)

O sistema continua usando o Supabase para contas e senhas. O Firebase só ENVIA o e-mail de "Esqueci minha senha", sem você configurar SMTP.

## Parte 1 – Firebase (uma vez só, ~5 min)
1. Acesse https://console.firebase.google.com e crie um projeto (ou use o do seu outro app).
2. Menu **Authentication > Começar > Método de login > E-mail/senha > Ativar > Salvar**.
3. **Configurações do projeto (engrenagem) > Geral > Chave de API da Web**: copie a chave (começa com `AIza`).
4. **Authentication > Modelos > Redefinição de senha**:
   - Clique no lápis; em **Idioma** escolha Português (Brasil).
   - Clique em **Personalizar URL de ação** e coloque: `https://SEU-DOMINIO/redefinir-senha` (o mesmo endereço do seu sistema, o valor de FRONTEND_URL).
   - Salve.
5. **Authentication > Configurações > Domínios autorizados**: adicione o domínio do seu sistema.

## Parte 2 – Servidor
1. Instale o zip por cima do projeto (mesmas pastas).
2. No arquivo `backend/.env` acrescente uma linha:
   `FIREBASE_API_KEY=AIza...sua-chave...`
3. Reinicie: `pm2 restart maquina --update-env`

## Teste
Em "Esqueci minha senha" digite o e-mail de um usuário cadastrado. O e-mail chega com o link; o usuário abre, digita a nova senha e pronto. Confira o spam na primeira vez.

## Observações
- Só usuários cadastrados no sistema recebem o e-mail (o Firebase cria o contato dele automaticamente).
- Se o Firebase falhar, o sistema tenta o e-mail próprio (SMTP) como antes; o erro aparece em `pm2 logs maquina`.
- Cada link vale uma vez só e expira em cerca de 1 hora (controle do Firebase).
- O limite gratuito do Firebase para e-mails de redefinição é alto, mas existe; contas com muitos pedidos seguidos podem receber erro temporário.

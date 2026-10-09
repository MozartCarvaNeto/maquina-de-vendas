# 🚀 Máquina de Vendas — Guia completo: acesso, planos, cobrança, recuperação de senha, celular, Docker e publicar online

> Escrito para quem **nunca** fez isso. Siga na ordem. Onde aparecer um bloco cinza, é para **copiar e colar**.
> Preços citados foram conferidos em **out/2026** e mudam com frequência: confirme no site antes de pagar.

---

## 0. O mapa (leia primeiro)

| Etapa | O que você faz | Tempo | Custo aproximado |
|---|---|---|---|
| **A** | Aplicar a atualização de controle de acesso no seu computador e testar | 30 min | R$ 0 |
| **B** | Aprender a usar o painel 🛡️ Administração | 15 min | R$ 0 |
| **C1** | Trocar senhas que vazaram | 20 min | R$ 0 |
| **C2** | Subir o código para o GitHub (privado) | 30 min | R$ 0 |
| **C3** | Alugar um servidor (VPS) e, se quiser, comprar domínio | 30 min | VPS ~US$ 5–20/mês · domínio .com.br R$ 40/ano |
| **C4** | Instalar o sistema no servidor | 1–2 h | — |
| **C5** | Testar e instalar como aplicativo no celular/PC | 20 min | R$ 0 |

**Por que precisa de um servidor ligado 24 horas?** Seu sistema abre um navegador "invisível" (Chromium) para manter o WhatsApp conectado, roda disparos agendados e recebe avisos da Twilio. Isso não pode "dormir até alguém acessar". Por isso **hospedagem grátis que dorme** (ex.: Render grátis desliga após 15 min sem acesso e não guarda arquivos) **não serve**.

---

# PARTE A — Aplicar a atualização de controle de acesso

## O que a atualização faz

- **Cadastro com aprovação:** quem clicar em "Criar conta" fica **pendente** e **não consegue entrar** até você aprovar.
- **Painel 🛡️ Administração** (só você vê): aprovar, bloquear, renovar, ver quanto tempo falta, histórico, observações, criar conta manual, gerar senha nova para o cliente.
- **Bloqueio automático por vencimento:** passou da data, o cliente é barrado **na hora** (até quem já estava logado), os disparos/follow-ups dele param e o WhatsApp dele é desligado no servidor.
- **Segurança:** o tempo real (Socket) agora exige login. Antes, qualquer pessoa que soubesse o ID de uma empresa poderia "escutar" o QR Code e as mensagens dela.
- **Celular:** menu lateral virou gaveta (botão ☰) e aviso de "assinatura vence em X dias" para o cliente.

## A.1 Copie os arquivos novos para o projeto

1. Extraia o arquivo **`atualizacao-controle-de-acesso.zip`**. Aparecem as pastas `backend`, `frontend`, `docs`, `deploy` e o arquivo `.gitignore`.
2. Abra a pasta do seu projeto (a que contém `backend` e `frontend`).
3. **Selecione tudo** dentro da pasta extraída, **copie** e **cole** na pasta do projeto.
4. Quando o Windows perguntar, escolha **"Substituir os arquivos no destino"**.

> Seus arquivos `.env`, `sessions` e `node_modules` **não** estão no pacote, então nada disso é apagado.

## A.2 Atualize o banco de dados (Supabase)

O arquivo cria tudo de uma vez: controle de acesso, **planos, cobrança automática e contador de uso** (versões 1 e 2). **Contas que já existem continuam ativas e sem vencimento** e sem limites (nada muda para elas).

**Jeito sem terminal (recomendado):**
1. Entre em **supabase.com** → seu projeto → menu **SQL Editor** → **New query**.
2. Abra o arquivo `docs/atualizar_banco_controle_de_acesso.sql` no Bloco de Notas, copie **tudo** e cole no Supabase.
3. Clique **Run**. Deve aparecer "Success".

> Pode rodar duas vezes sem problema (ele só cria o que falta).

## A.3 Configure o `.env` do backend

Abra `backend/.env` no Bloco de Notas e **acrescente no final**:

```
SUPERADMIN_EMAILS=seu-email-de-login@exemplo.com
REGISTRATION_MODE=approval
TRIAL_DAYS=0
GRACE_DAYS=0
```

> As variáveis da v2 (e-mail do sistema, cobrança Asaas) estão na **Parte F** — o arquivo `backend/env.example` traz todas comentadas.

- **`SUPERADMIN_EMAILS`**: coloque o **mesmo e-mail com que você já faz login hoje**. Esse usuário vira o administrador (vê o menu 🛡️ e nunca é bloqueado). Vários e-mails: separe por vírgula.
- **`REGISTRATION_MODE`**:
  - `approval` → a pessoa se cadastra e **espera você aprovar** *(recomendado)*
  - `closed` → desliga o cadastro público (você cria as contas no painel)
  - `open` → libera na hora (use com `TRIAL_DAYS=7`, por exemplo, para dar 7 dias de teste)
- **`GRACE_DAYS`**: dias de tolerância depois do vencimento. `0` = bloqueia assim que passa a data.

## A.4 Reinstale, recompile e rode

Abra o **Prompt de Comando** e rode (um bloco por vez):

```
cd caminho\do\projeto\backend
npm install
npx prisma generate
```

```
cd ..\frontend
npm install
npm run build
```

```
cd ..\backend
npm start
```

No terminal você deve ver, entre outras linhas:

```
🔐 Cadastro público: modo "approval"
✅ Varredura de assinaturas vencidas ativa (5 min)
🛡️  Administrador da plataforma liberado: seu-email@...
```

Se aparecer `⚠️ SUPERADMIN_EMAILS contém ..., mas esse usuário ainda não existe`, o e-mail está diferente do usado no login.

## A.5 Teste

1. Abra **http://localhost:3333** e **saia e entre de novo** (para o menu novo carregar).
2. Aparece **🛡️ Administração** no menu → clique.
3. Clique **➕ Nova conta**, crie um cliente de teste com 7 dias.
4. Abra uma **janela anônima**, entre com o cliente de teste → funciona.
5. De volta ao painel → **Detalhes** → **⛔ Bloquear**. Recarregue a janela anônima → é expulso com a mensagem de suspensão.
6. **Desbloquear**. Mude o vencimento para uma data passada → bloqueia sozinho. Renove **+30 dias** → volta.
7. Na janela anônima, clique em **Criar conta**, cadastre outro e-mail → aparece "aguardando aprovação". No painel ele aparece em **Pendentes** → **✅ Aprovar 30d**.
8. **Muito importante:** vá em **Conexões** e confira que o **QR Code ainda aparece** (o tempo real mudou).

---

# PARTE B — Usando o painel no dia a dia

| Quero... | Faça |
|---|---|
| Liberar quem acabou de se cadastrar | Filtro **Pendentes** → **✅ Aprovar 30d** (ou **Detalhes** para escolher outro prazo) |
| Vender para uma empresa | **➕ Nova conta** → preencha → entregue o e-mail e a senha mostrados (não aparecem de novo) |
| Cliente pagou o mês | Linha do cliente → **🔄 +30 dias** (soma ao vencimento atual; se já venceu, conta a partir de hoje) |
| Ver quem está para vencer | Cartão **Vencem em 7 dias** |
| Bloquear inadimplente | **Detalhes** → motivo → **⛔ Bloquear** (derruba o WhatsApp dele na hora) |
| Cliente esqueceu a senha | **Detalhes** → **🔑 Gerar nova senha** |
| Dar mais prazo sem cobrar | **Detalhes** → ajuste a data de **Vencimento** → **Salvar** |

**Regras que o sistema aplica sozinho**
- Venceu → login bloqueado, requisições bloqueadas, disparos e follow-ups pausados, WhatsApp desligado (varredura a cada 5 min; ao bloquear manualmente é imediato).
- Renovou/desbloqueou → o WhatsApp **volta sozinho** (se a sessão ainda estiver salva no servidor).
- Sua conta (administrador) **nunca vence nem é bloqueada** e não aparece nas contagens de clientes.

**Cobrança:** por padrão a renovação é **manual** (cliente paga → você clica +30 dias). Para renovar **sozinho** quando o cliente pagar, ligue a cobrança automática (**Parte F.5**). Para limitar o que cada cliente pode usar, crie **planos** (**Parte F.4**).

---

# PARTE C — Colocar online

## C1. 🔐 Antes de tudo: troque o que vazou

O arquivo `.env` que você me enviou continha senhas reais. Trate-as como **comprometidas** e troque:

1. **Senha do banco no Supabase**: Project Settings → Database → *Reset database password*. Depois atualize `DATABASE_URL` no `.env`.
2. **Token da Twilio**: console da Twilio → Account → *Auth Tokens* → criar/rotacionar. Atualize no `.env`/Configurações do sistema.
3. **`JWT_SECRET`**: gere um novo (isso desloga todos, sem problema agora):
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
4. ⚠️ **NÃO troque `SETTINGS_ENCRYPTION_KEY`.** Ela cifra as chaves salvas no banco (IA, Twilio etc.). Trocar = essas chaves ficam ilegíveis. **Use sempre o mesmo valor** em todo computador/servidor.

> Regra de ouro: **`.env` nunca vai para o GitHub, nunca vai em print, nunca vai por conversa.**

## C2. GitHub: sim, suba o código (privado)

**Por que?** (1) é o "cofre" do seu código, com histórico; (2) é o jeito mais fácil de levar o código ao servidor e **atualizar depois com um comando**; (3) se seu PC quebrar, nada se perde.

**Deve ser PRIVADO** — é o produto que você vai vender.

### C2.1 O `.gitignore` (já está no pacote)

É uma lista do que **não** deve subir. O arquivo `.gitignore` na raiz do projeto já bloqueia:

| Bloqueado | Por quê |
|---|---|
| `.env` | tem senhas |
| `node_modules/` | enorme e se recria com `npm install` |
| `frontend/dist/` | se recria com `npm run build` |
| `backend/sessions/` e `.wwebjs_*` | são o "login" do seu WhatsApp (valem como senha) |
| `backend/uploads/*` | arquivos enviados por clientes |

O arquivo `.env.example`/`env.example` **sobe** (é só um modelo, sem senhas).

### C2.2 Jeito mais fácil: GitHub Desktop (sem comandos)

1. Crie conta em **github.com** (grátis).
2. Baixe e instale o **GitHub Desktop** (desktop.github.com) e entre com sua conta.
3. **Confirme que o `.gitignore` está na raiz** do projeto (ao lado das pastas `backend` e `frontend`). *Faça isso antes do próximo passo.*
4. GitHub Desktop → **File → Add local repository…** → escolha a pasta do projeto → ele dirá que não é um repositório → clique em **create a repository**.
   - Name: `maquina-de-vendas` · Git ignore: **None** (já temos o nosso) · **Create repository**.
5. Na aba **Changes** confira a lista de arquivos:
   - ✅ Deve ter **algumas centenas** de arquivos (código-fonte).
   - 🛑 Se tiver **milhares** ou aparecer `node_modules`, `.env` ou `sessions`: **PARE**. O `.gitignore` não foi aplicado (arquivo no lugar errado ou com nome errado).
6. Embaixo à esquerda, em *Summary*, escreva `Primeira versão` → **Commit to main**.
7. Clique **Publish repository** → **marque "Keep this code private"** → **Publish**.
8. Entre em github.com → seu repositório → confirme que **não existe** arquivo `.env` nem pasta `node_modules`.

**Para enviar mudanças depois:** edite → GitHub Desktop → Summary → **Commit** → **Push origin**.

### C2.3 (Alternativa) Pelo terminal

```
cd caminho\do\projeto
git init
git add .
git status
git commit -m "Primeira versão"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/maquina-de-vendas.git
git push -u origin main
```
(Antes crie o repositório **vazio e privado** em github.com → *New repository*. Leia o `git status` antes do commit: se listar `node_modules` ou `.env`, pare.)

## C3. Onde hospedar (explicado sem mistério)

**Frontend e backend não precisam de lugares separados.** No seu projeto o backend já entrega o site (`frontend/dist`) — é **um único programa** rodando. Isso simplifica tudo: um servidor, um endereço.

| Opção | Serve? | Observação |
|---|---|---|
| **VPS** (servidor virtual alugado) | ✅ **Recomendado** | Fica ligado 24h, você controla tudo, preço fixo. Pede ~1–2 h de configuração (este guia). |
| **Railway / similares (PaaS)** | ⚠️ Possível | Mais fácil de começar, mas cobra **por uso** (Hobby: US$ 5/mês com US$ 5 de uso incluso; navegador Chromium 24h costuma passar disso — acompanhe a fatura). Precisa de volume para guardar a sessão do WhatsApp. |
| **Render plano grátis** | ❌ | Dorme após 15 min sem acesso e **não guarda arquivos** (perderia o WhatsApp a cada reinício). |
| **Vercel / Netlify** | ❌ | Só para sites estáticos; não rodam navegador 24h nem WhatsApp. |
| **Seu PC em casa** | ⚠️ Só para teste/demonstração | Precisa ficar ligado e com internet estável; não recomendo para clientes. |

### Como escolher o VPS
Procure por: **Ubuntu 24.04 (ou 22.04)** · **2 vCPU** · **mínimo 2 GB de RAM (ideal 4 GB)** · **40 GB+ de disco** · **IPv4 incluso**. Se houver data center em **São Paulo**, prefira (menor atraso). Candidatos comuns: Hostinger, Vultr, AWS Lightsail, Locaweb, Contabo, Hetzner (Europa) — **confira preço e disponibilidade na hora**; em 2026 os valores oscilaram bastante (a Hetzner, por exemplo, reajustou duas vezes e deixou planos baratos indisponíveis por períodos). Reserve algo entre **US$ 5 e US$ 20/mês**.

> **Dimensionamento honesto:** cada WhatsApp conectado mantém um navegador aberto (algumas centenas de MB de RAM). Com poucos clientes, 4 GB aguenta bem; com muitos, suba o plano. Monitore com `pm2 monit`.

## C4. Domínio: precisa comprar já?

| Opção | Custo | Quando usar |
|---|---|---|
| **Só o IP** (`http://123.45.67.89`) | grátis | ❌ Não serve: sem HTTPS não instala como app e a Twilio exige endereço seguro |
| **Subdomínio grátis** (DuckDNS: `meunegocio.duckdns.org`) | grátis | ✅ **Para testar** tudo antes de pagar |
| **Domínio próprio `.com.br`** (registro.br) | ~R$ 40/ano (precisa de CPF/CNPJ) | ✅ **Para vender** |
| **`.com`** em revendedores | ~R$ 20–50/ano | ✅ Alternativa |

### ⚠️ Decisão importante: escolha o domínio **antes** de ter clientes
O app instalado no celular e o login ficam **presos ao endereço**. Se você trocar de endereço depois, **todo cliente precisa reinstalar o app e entrar de novo**, e você precisa atualizar a Twilio. Então:
- **Testes:** use DuckDNS à vontade.
- **Cliente pagante:** só depois de comprar o domínio definitivo.

**Trocar de endereço depois (se precisar):** (1) apontar o novo DNS para o IP; (2) editar `server_name` no Nginx; (3) rodar o Certbot para o novo nome; (4) atualizar `BACKEND_PUBLIC_URL` e `FRONTEND_URL` no `.env`; (5) `pm2 restart maquina`; (6) atualizar URLs na Twilio; (7) clientes reinstalam o app.

### Comprando o domínio (registro.br)
1. **registro.br** → *Registrar domínio* → pesquise o nome → crie conta (CPF/CNPJ) → pague.
2. Depois de pago: **Painel → seu domínio → Editar zona / DNS**. Crie um registro **tipo A**:
   - Nome: `app` · Valor: **o IP do seu servidor**
3. O endereço será `app.seudominio.com.br`. A propagação leva de minutos a algumas horas.
   Teste no Prompt: `nslookup app.seudominio.com.br` → deve mostrar o IP do servidor.

### Alternativa grátis (DuckDNS)
1. **duckdns.org** → entre com Google/GitHub → digite um nome em *sub domain* → **add domain**.
2. Em *current ip* coloque o IP do servidor → **update ip**.
3. Seu endereço é `nome.duckdns.org`.

## C5. Instalar o sistema no servidor (passo a passo)

> Você vai digitar comandos num programa de texto que fica **dentro do servidor**. É normal: copie, cole, aperte Enter. A senha não aparece enquanto você digita.

### 1) Contratar o VPS
Escolha Ubuntu 24.04, finalize. O provedor mostra o **IP** e a **senha do usuário `root`**. Anote.

### 2) Conectar
No seu PC: tecla Windows → digite **PowerShell** → abra:
```
ssh root@SEU_IP
```
Responda `yes` na primeira vez e digite a senha.

### 3) Preparar o servidor (cole um bloco por vez)
```
apt update && apt upgrade -y
apt install -y curl git unzip nginx certbot python3-certbot-nginx ufw procps nano
```
Node.js 20:
```
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
npm install -g pm2
node -v
```
Google Chrome (instala todas as bibliotecas que o WhatsApp precisa):
```
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
apt install -y ./google-chrome-stable_current_amd64.deb
```
Se o servidor tem **2 GB de RAM**, crie memória de reserva:
```
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 4) Baixar o código do GitHub (repositório privado)
O servidor precisa de uma "chave" para ler seu repositório privado:
```
ssh-keygen -t ed25519 -C "servidor" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```
Copie a linha que aparece (começa com `ssh-ed25519`). No GitHub: **seu repositório → Settings → Deploy keys → Add deploy key** → cole → *Allow write access* **desmarcado** → **Add key**. Depois:
```
git clone git@github.com:SEU_USUARIO/maquina-de-vendas.git
cd maquina-de-vendas
```
(Responda `yes` à pergunta sobre autenticidade do host.)

### 5) Criar o `.env` no servidor
O `.env` **não está no GitHub** de propósito. Crie na mão:
```
nano backend/.env
```
Cole e ajuste (use os **mesmos** `SETTINGS_ENCRYPTION_KEY` de antes e a **nova** senha do banco):
```
PORT=3333
NODE_ENV=production
BACKEND_PUBLIC_URL=https://app.seudominio.com.br
FRONTEND_URL=https://app.seudominio.com.br
DATABASE_URL=postgresql://...(string do Supabase)
JWT_SECRET=...(o novo, gerado no C1)
JWT_EXPIRES_IN=7d
SETTINGS_ENCRYPTION_KEY=...(o MESMO de sempre)

SUPERADMIN_EMAILS=seu-email-de-login@exemplo.com
REGISTRATION_MODE=approval
TRIAL_DAYS=0
GRACE_DAYS=0
```
Salvar no nano: **Ctrl+O**, Enter, **Ctrl+X**.

> **Opcionais da v2** (e-mail do sistema para "Esqueci minha senha", cobrança Asaas, contato de suporte): coloque no mesmo arquivo — veja **F.2** e **F.5**.

**Sobre cada variável**
| Variável | O que é | Em produção |
|---|---|---|
| `NODE_ENV` | modo de execução | `production` |
| `BACKEND_PUBLIC_URL` / `FRONTEND_URL` | endereço do site, **com https, sem barra no final** | seu domínio (substitui o link do ngrok, que **não é mais necessário**) |
| `DATABASE_URL` | conexão com o Supabase | se der erro `Can't reach database server`, use a string **Session pooler** do Supabase (alguns servidores não têm IPv6) |
| `JWT_SECRET` | assina os logins | segredo novo e longo |
| `SETTINGS_ENCRYPTION_KEY` | cifra chaves salvas | **idêntica** à de sempre |
| Demais (Twilio etc.) | integrações | copie do seu `.env` atual, com as chaves rotacionadas |

> Guarde uma cópia do `.env` num **gerenciador de senhas** (Bitwarden, 1Password). É assim que ele "viaja" entre máquinas — nunca pelo GitHub.

### 6) Instalar e compilar
```
cd ~/maquina-de-vendas/backend
npm install
npx puppeteer browsers install chrome
npx prisma generate
cd ../frontend
npm install
npm run build
```
> **Não crie `frontend/.env`** no servidor. Sem ele o site usa o próprio endereço de onde foi aberto.

### 7) Ligar e deixar rodando 24h (PM2)
```
cd ~/maquina-de-vendas/backend
pm2 start src/server.js --name maquina
pm2 save
pm2 startup
```
O último comando mostra **outra linha** começando com `sudo env PATH=...`. **Copie e execute essa linha.** Agora o sistema volta sozinho se o servidor reiniciar.
Ver o que está acontecendo: `pm2 logs maquina`.

### 8) Nginx (o "porteiro") e HTTPS (o cadeado)
```
nano /etc/nginx/sites-available/maquina
```
Cole o conteúdo de `deploy/nginx-maquina-de-vendas.conf` (trocando `app.seudominio.com.br` pelo seu endereço) e salve. Ative:
```
ln -s /etc/nginx/sites-available/maquina /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```
Gere o certificado grátis (Let's Encrypt):
```
certbot --nginx -d app.seudominio.com.br
```
Informe seu e-mail, aceite os termos e escolha redirecionar HTTP→HTTPS se perguntar.

### 9) Firewall
```
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```
(A porta 3333 **não** fica aberta ao público — só o Nginx fala com ela.)

## C6. Primeiro acesso e testes

1. Abra `https://app.seudominio.com.br` (deve mostrar o 🔒).
2. Entre com seu e-mail de administrador. O menu **🛡️ Administração** deve aparecer.
3. **Conexões → Gerar novo QR** → escaneie. **(Desligue o sistema do seu PC de casa antes** — um WhatsApp só pode estar aberto em um lugar.)
4. Crie uma conta de teste no painel e entre por uma janela anônima.
5. Cadastre-se pelo "Criar conta" e confirme que cai em "aguardando aprovação".
6. Se usa Twilio: abra o console da Twilio e troque qualquer URL antiga (ngrok) pelo novo endereço.

## C7. Virar aplicativo instalável (PWA)

**O seu projeto já está preparado** (manifesto, ícones, service worker e aviso de "Nova versão" já existem). O que faltava era **HTTPS** — que você acabou de configurar. Navegadores só oferecem "instalar" em endereço seguro.

### Verificando
No Chrome do computador, abra o site → tecla **F12** → aba **Application** → **Manifest**: não deve haver erros em vermelho, e em **Service workers** deve constar *activated*.

### Instalando
| Aparelho | Como |
|---|---|
| **Android (Chrome)** | Abra o site → botão **📲 Instalar aplicativo** que aparece no sistema, ou menu ⋮ → **Instalar app** |
| **iPhone/iPad** | **Tem que ser no Safari.** Botão **Compartilhar** (quadrado com seta) → **Adicionar à Tela de Início** → Adicionar |
| **Windows/Mac (Chrome/Edge)** | Ícone de instalar na barra de endereço (à direita), ou menu → **Instalar Máquina de Vendas** |

Depois de instalado, o ícone fica na tela inicial/menu iniciar e abre **sem barra de endereço**, como um app.

### Para o cliente final (mensagem pronta)
> "Acesse **https://app.seudominio.com.br**, entre com o e-mail e a senha que enviei. Para ter como aplicativo: no Android toque em ⋮ → *Instalar app*; no iPhone abra no Safari → Compartilhar → *Adicionar à Tela de Início*."

### Limites que você precisa saber
- **Precisa de internet**: o app instalado abre a "casca" sem rede, mas os dados vêm do servidor.
- **Não há notificações push** (aviso com o app fechado) — isso não existe no sistema hoje; não prometa a clientes.
- **Telas internas no celular:** o menu e o layout geral já são adaptados. Telas muito largas (CRM em colunas, tabelas grandes) podem precisar de ajustes de layout individuais — teste cada uma no celular e me peça os ajustes.
- **Atualizações:** quando você publica versão nova, quem está com o app aberto vê **"Nova versão disponível → Atualizar agora"**.

## C8. Atualizando o sistema no futuro

Fluxo de sempre: **mexe no PC → testa → GitHub Desktop (Commit + Push) → no servidor:**
```
ssh root@SEU_IP
cd ~/maquina-de-vendas
bash deploy/atualizar-servidor.sh
```
Quando a mudança incluir **tabelas novas no banco**: `bash deploy/atualizar-servidor.sh --banco` (**faça backup antes**).

## C9. Backup, monitoramento e segurança mínima

- **Banco (Supabase):** confirme no seu plano se há **backups automáticos**; se não houver, crie rotina de exportação. É o seu maior ativo — clientes, leads, histórico.
- **Sessões do WhatsApp:** copie ocasionalmente `~/maquina-de-vendas/backend/sessions` para não ter de ler QR de novo se o servidor for refeito. (Essa pasta é sensível: trate como senha.)
- **Aviso de queda grátis:** crie conta em **uptimerobot.com** → *Add monitor* → HTTPS → seu endereço → receba e-mail/WhatsApp quando cair.
- **Atualizações automáticas de segurança do Ubuntu:**
  ```
  apt install -y unattended-upgrades
  dpkg-reconfigure -plow unattended-upgrades
  ```
- **Senha do servidor forte e única.** (Avançado, opcional: trocar senha por chave SSH — só faça se souber recuperar o acesso, senão pode ficar sem entrar.)
- **Clientes e LGPD:** você passa a guardar dados de terceiros. Tenha termos de uso, política de privacidade e contrato com cada cliente.
- **Risco de banimento do WhatsApp:** disparo em massa por sessão não oficial (QR Code) viola os termos do WhatsApp e pode banir o número do **seu cliente**. Avise isso em contrato; para volume use a **API Oficial da Meta** (o sistema já tem esse modo).

---

# PARTE D — Problemas comuns

| Sintoma | Causa provável | Solução |
|---|---|---|
| Site não abre | DNS ainda não propagou / Nginx | `nslookup seu.endereco`; `systemctl status nginx`; `pm2 status` |
| `502 Bad Gateway` | sistema parado | `pm2 logs maquina --lines 50` (veja o erro) → `pm2 restart maquina` |
| Abre, mas **QR não aparece** | falta `Upgrade/Connection` no Nginx, ou Chromium | confira o arquivo do Nginx; rode `npx puppeteer browsers install chrome` em `backend`; `pm2 logs` e procure `QR RECEBIDO` |
| Entra e volta ao login | token/relógio ou site antigo no cache | limpe dados do site; confira `JWT_SECRET` |
| "aguardando aprovação" para você | e-mail diferente de `SUPERADMIN_EMAILS` | corrija o `.env` e `pm2 restart maquina` |
| Menu 🛡️ não aparece | usuário salvo antigo no navegador | saia e entre de novo |
| Cliente vê "assinatura venceu" mas já pagou | falta renovar | painel → **🔄 +30 dias** (efeito imediato) |
| `Can't reach database server` | IPv6/rede | use a string **Session pooler** do Supabase |
| Memória acabando / cai | servidor pequeno | `free -h`; crie swap (C5.3) ou suba o plano |
| "Muitas tentativas de login" (429) | 5 senhas erradas seguidas | aguarde ~15 min, ou reinicie (`pm2 restart maquina` / `docker compose restart app`), ou use "Esqueci minha senha" |
| Não chega o e-mail de "Esqueci minha senha" | falta o e-mail do sistema (`SYSTEM_SMTP_*`) | F.2; veja `pm2 logs maquina` (aparece "Não foi possível enviar e-mail") e confira spam; alternativa: painel → **🔑 Gerar nova senha** |
| "Limite de X ... do plano" (403) | o plano da empresa chegou no limite | painel → **Detalhes** → trocar o plano, ou **Planos** → editar limites |
| Cliente pagou e não liberou | webhook do Asaas não chegou | F.5 passo 3 (URL e token iguais?); no Asaas veja o histórico de envios do webhook; painel → **🔄 +30 dias** como quebra-galho |
| WhatsApp caiu depois de bloqueio/renovação | sessão não estava salva | **Conexões → Gerar novo QR** |

---

# PARTE E — Honestidade técnica e próximos passos

**O que foi verificado ao montar este pacote (testes automáticos com banco e Asaas SIMULADOS)**
- Regras de assinatura (vencimento, tolerância, bloqueio, pendência, administrador isento) e **todas as rotas do painel**.
- **Limite de tentativas** de login (bloqueia na 6ª, expira sozinho, não afeta outros e-mails) e **recuperação de senha** (resposta idêntica para e-mail existente ou não, link de uso único, limite por e-mail).
- **Planos e limites**: conexões, usuários e cota mensal de mensagens (pausa o disparo ao zerar).
- **Cobrança**: checkout, webhook com token, **aviso duplicado ou simultâneo renova só uma vez**, renovação soma ao vencimento, bloqueio manual não é desfeito por pagamento, conta vencida entra só para pagar.
- O `schema.prisma` foi validado pelo Prisma e o SQL foi conferido coluna a coluna contra o schema.
- O código do frontend teve a **sintaxe validada**.

**O que NÃO foi possível verificar aqui — faça você (testes em F.9):**
- Rodar contra o **Supabase real**.
- **Compilar o frontend** (`npm run build`) e olhar as telas no celular (o ambiente não instala dependências nem abre navegador). Se o build der erro, envie o texto.
- A integração **real com o Asaas** (testei só com respostas simuladas): faça o teste no **sandbox** (F.5) antes de cobrar de verdade.
- O **Dockerfile** (não há Docker no ambiente onde trabalhei): o primeiro `docker compose up --build` pode pedir um ajuste; envie o log.
- O fluxo real de **QR Code/Socket** após a mudança de segurança.

**Próximos passos possíveis**
1. Avisos por e-mail ao cliente (7 dias antes de vencer, pagamento recebido).
2. Outros meios de cobrança (Mercado Pago, Stripe): a estrutura já isola o provedor em `services/billing`.
3. Autenticação em 2 fatores para o administrador.
4. Teste e refinamento de cada tela no celular, com base em prints seus.
5. Emissão automática de nota fiscal (ver com seu contador e o Asaas).

---

# PARTE F — Recuperação de senha, planos, cobrança, celular e Docker (v2)

## F.1 Aplicar a atualização v2

1. Extraia `atualizacao-controle-de-acesso.zip` e **copie por cima do projeto** (substituir), como na A.1.
2. **Banco:** rode de novo `docs/atualizar_banco_controle_de_acesso.sql` no SQL Editor do Supabase (pode repetir; só cria o que falta).
3. **`.env`:** copie as linhas novas que quiser de `backend/env.example` (F.2 e F.5 explicam cada uma).
4. Backend: `npm install` → `npx prisma generate`. Frontend: `npm install` → `npm run build`. Depois `npm start` (ou `pm2 restart maquina` no servidor).
5. **Saia e entre de novo** no sistema (para o menu novo carregar).

## F.2 "Esqueci minha senha" funcionando de verdade

**O que existia:** a tela e o link já existiam, mas o e-mail só saía se o **cliente** tivesse configurado um e-mail em Configurações. Um cliente novo nunca teria — então a recuperação falhava justamente para ele.

**O que há agora**
- O link **"Esqueci minha senha"** fica logo abaixo do campo de senha.
- O sistema envia o e-mail com **seu e-mail do sistema** (`SYSTEM_SMTP_*`), com botão grande e link que vale **1 hora** e **só funciona 1 vez**.
- A resposta na tela é **sempre a mesma**, exista o e-mail ou não (ninguém consegue descobrir quem é seu cliente).
- Limites: 3 pedidos por hora por e-mail e 10 por hora por endereço.
- No celular o e-mail é aceito mesmo digitado com letra maiúscula, e há o botão 👁️ para ver a senha.

**Configurar o e-mail do sistema (exemplo com Gmail)**
1. Na conta Google que enviará os e-mails: **Conta Google → Segurança → Verificação em duas etapas** (ative).
2. Ainda em Segurança, procure **Senhas de app** → crie uma (nome: "Máquina de Vendas") → o Google mostra **16 letras**. Copie.
3. No `backend/.env`:
```
SYSTEM_SMTP_HOST=smtp.gmail.com
SYSTEM_SMTP_PORT=587
SYSTEM_SMTP_USER=seu-email@gmail.com
SYSTEM_SMTP_PASS=as16letrasdasenhadeapp
SYSTEM_MAIL_FROM=Máquina de Vendas <seu-email@gmail.com>
SUPPORT_CONTACT=WhatsApp (11) 99999-9999
```
4. Reinicie e teste: saia, clique em **Esqueci minha senha**, digite seu e-mail e confira a caixa (e o spam).

> Para uma operação profissional, o ideal é um e-mail do **seu domínio** (ex.: `nao-responda@seudominio.com.br`) por um provedor de e-mail transacional (Brevo, Resend, Zoho etc. — confira o plano gratuito atual de cada um). Eles dão os mesmos 4 dados (host, porta, usuário, senha), que entram nas mesmas linhas do `.env`.

**Se o e-mail não chegar:** `pm2 logs maquina` mostra "Não foi possível enviar e-mail de redefinição". Plano B sempre disponível: painel **🛡️ Administração → Detalhes → 🔑 Gerar nova senha**; para usuários de uma empresa, o dono usa **Equipe**.

## F.3 Limite de tentativas de login

- **5 senhas erradas** seguidas para o mesmo e-mail, vindas do mesmo endereço, bloqueiam novas tentativas por **15 minutos** (mesmo que a próxima senha esteja certa). Outros e-mails não são afetados. Acima de 30 erros por endereço, o endereço todo é bloqueado.
- Acertar a senha zera a contagem.
- O contador fica na memória: **reiniciar o sistema libera** (útil se você mesmo se bloquear).
- Depende de `TRUST_PROXY=1` (já é o padrão) para enxergar o IP real atrás do Nginx/Caddy. **Nunca exponha a porta 3333 direto na internet.**

## F.4 Planos e limites

**Criar planos:** menu **🛡️ Administração → aba 💼 Planos e preços** → **✨ Criar planos de exemplo** (depois edite os valores) ou **➕ Novo plano**.

Cada plano tem: preço, ciclo (mensal, trimestral, semestral, anual), e limites — **campo vazio = sem limite**:

| Limite | O que bloqueia quando acaba |
|---|---|
| Conexões de WhatsApp | criar nova conexão em **Conexões** |
| Usuários | convidar novo usuário em **Equipe** |
| Mensagens de disparo por mês | criar disparo novo e **pausa** o que está rodando (zera no 1º dia do mês, horário de Brasília) |

**Definir o plano de um cliente:** **Detalhes** da conta → **💼 Plano e cobrança** → escolha → **Definir plano**. O efeito é imediato e você vê o **uso** (ex.: WhatsApps 1/3).

Regras importantes
- Conta **sem plano = sem limites novos** (como era antes). Sua conta de administrador nunca é limitada.
- Mudar o plano **não muda o vencimento**; o vencimento muda por pagamento ou por você (renovar).
- Plano que já tem clientes **não é apagado**: só desativado (some da vitrine; quem já tem continua).
- A contagem de mensagens considera **disparos** (não conversas no Chat). Disparo recorrente conta a cada envio.
- Se baixar o limite abaixo do que o cliente já usa, nada é apagado: ele apenas não consegue **criar mais**.

## F.5 Cobrança automática com Asaas (passo a passo)

**Como funciona:** o cliente escolhe o plano na tela **💳 Minha assinatura** → paga (PIX, boleto ou cartão) → o Asaas avisa o seu sistema → o acesso é **liberado/renovado sozinho** pelo ciclo do plano. Se não pagar, o vencimento passa e o bloqueio por data acontece automaticamente; o cliente ainda consegue **entrar só para pagar** (os dados ficam guardados, os disparos e o WhatsApp dele ficam parados).

**Passo 1 — Conta de TESTE (sandbox)**
1. Crie uma conta no **ambiente de testes (sandbox) do Asaas** (veja o link na documentação em docs.asaas.com). Nada é cobrado de verdade.
2. No painel do sandbox, procure **Integrações → Chave de API** e gere uma chave.

**Passo 2 — `.env` do servidor**
```
ASAAS_API_KEY=a_chave_do_sandbox
ASAAS_ENV=sandbox
ASAAS_WEBHOOK_TOKEN=invente-uma-senha-longa-aqui
AUTO_ACTIVATE_ON_PAYMENT=true
GRACE_DAYS=3
```
Gere o token com: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`. Reinicie o sistema.

> **Por que `GRACE_DAYS=3`:** boleto pode levar dias úteis para "compensar". A tolerância evita bloquear quem já pagou e está só aguardando.

**Passo 3 — Webhook (o "aviso de pagamento")**
No painel do Asaas: **Integrações → Webhooks → novo**:
- **URL:** `https://app.seudominio.com.br/api/webhooks/asaas`
- **Token de autenticação:** exatamente o mesmo `ASAAS_WEBHOOK_TOKEN`
- **Eventos de cobrança:** marque os de **pagamento confirmado/recebido**, **vencido**, **estornado** e **chargeback**.
- Ative o envio sequencial.

O webhook precisa de endereço **público com HTTPS**: ele só funciona depois que o sistema está no ar (F.1 + Parte C). Não funciona com `localhost`.

**Passo 4 — Teste ponta a ponta (sandbox)**
1. **Planos**: crie um plano de R$ 5,00 mensal.
2. Em janela anônima: **Criar conta** → entre → você cai na tela **Minha assinatura** (modo "só pagar").
3. Escolha o plano, informe um CPF/CNPJ de teste → abre a página de pagamento do Asaas.
4. No sandbox, **confirme o pagamento manualmente** no painel do Asaas (há opção de simular recebimento).
5. Em até alguns segundos a tela diz "✅ Pagamento confirmado" e abre o sistema. No painel 🛡️ o histórico mostra **💰 Pagamento**.
6. Teste também: aviso duplicado (não renova 2 vezes) e conta bloqueada manualmente (pagar **não** desbloqueia).

**Passo 5 — Valendo (produção)**
1. Conclua o cadastro/verificação da sua conta **de produção** no Asaas (eles pedem documentos).
2. Gere a **chave de produção**; no `.env`: `ASAAS_API_KEY=a_chave_de_producao` e `ASAAS_ENV=production`.
3. Cadastre o **webhook também no painel de produção** (mesma URL e mesmo token).
4. `pm2 restart maquina` (ou `docker compose restart app`).
5. Faça uma compra real de valor baixo para validar.

**Dia a dia**
- Cliente novo: ele mesmo se cadastra e paga; **ou** você cria a conta no painel, define o plano e clica **💳 Gerar cobrança recorrente** (copie o link e mande por WhatsApp).
- Trocar de plano: o cliente escolhe outro na tela dele; o sistema cancela a assinatura antiga e cria a nova.
- Cancelar a recorrência: painel → **Detalhes → Cancelar recorrência** (o cliente mantém o acesso até o vencimento).
- **Tarifas** do Asaas por transação: confira na tabela atual do próprio Asaas e leve em conta no preço do plano.

**Cuidados**
- Cartão: o Asaas avisa "confirmado" logo e "recebido" cerca de 30 dias depois; o sistema renova **na primeira confirmação** e ignora a repetida.
- Estorno/chargeback: o sistema **só registra** no histórico (↩️) — você decide se bloqueia.
- Impostos, nota fiscal e contrato com o cliente: converse com seu contador/advogado.

## F.6 Celular

O que foi ajustado
- Menu lateral vira gaveta (☰); barra do topo fixa.
- **Chat:** uma tela por vez (lista → conversa, com botão ← para voltar).
- **CRM:** as colunas deslizam de lado, uma por vez.
- **Tabelas** rolam dentro da própria caixa; **janelas** cabem na tela; **pop-up de ligação** ocupa a largura.
- Campos com 16 px (o iPhone não dá "zoom" sozinho), botões maiores, teclado de e-mail sem letra maiúscula e botão 👁️ na senha.
- **Painel de administração** e **Minha assinatura** foram feitos já pensando em celular.

**Como testar no computador antes:** abra o sistema no Chrome → **F12** → clique no ícone de celular (ou **Ctrl+Shift+M**) → escolha um aparelho (ex.: iPhone 14) → navegue por todas as telas.

**Lista para conferir:** Dashboard · Chat (abrir conversa e voltar) · CRM · Campanhas · Listas · Disparos (criar e ver detalhes) · Conexões (QR Code) · Discador · Ligações · Linhas · Equipe · Contatos · Configurações · Administração · Minha assinatura.
Se alguma tela ficar ruim, **tire um print e me envie** com o nome da tela: ajusto cada uma.

## F.7 Instalação com Docker (alternativa à Parte C5)

**Escolha UM caminho:** ou o da C5 (Node + PM2 + Nginx) **ou** este (Docker). Docker é mais fácil de repetir em outro servidor e de atualizar; o HTTPS é automático (Caddy).

1. Servidor Ubuntu 24.04 (mesmos requisitos da C3) e o **DNS já apontando** o domínio para o IP (Caddy só consegue o cadeado se o endereço já existir).
2. Instale o Docker:
```
curl -fsSL https://get.docker.com | sh
```
3. Baixe o código (chave de implantação e `git clone`, exatamente como na **C5 passo 4**).
4. Crie os **dois** arquivos de configuração:
   - `backend/.env` (como na C5.5 — **não precisa** de `BACKEND_PUBLIC_URL`, `FRONTEND_URL` nem `PORT`: o Docker define).
   - `.env` na **raiz** do projeto (ao lado do `docker-compose.yml`) com a linha: `DOMAIN=app.seudominio.com.br` (modelo em `deploy/docker.env.example`).
5. Suba tudo (a 1ª vez leva alguns minutos):
```
cd ~/maquina-de-vendas
docker compose up -d --build
docker compose ps
```
6. Acompanhe: `docker compose logs -f app --tail 50`. Abra `https://app.seudominio.com.br`.
7. Se o banco for novo e vazio: `docker compose exec app npx prisma db push`.
8. Firewall: `ufw allow OpenSSH`, `ufw allow 80`, `ufw allow 443`, `ufw enable`.

**Atualizar:** `bash deploy/atualizar-docker.sh` (com `--banco` quando houver tabelas novas).

**Onde ficam os dados:** em "volumes" do Docker (`sessions`, `uploads`, `wwebjs_cache`). Eles **sobrevivem** a atualizações. **Nunca rode** `docker compose down -v` (apaga os volumes e você terá de ler os QR Codes de novo).
Backup das sessões: `docker run --rm -v maquina-de-vendas_sessions:/data -v "$PWD":/backup alpine tar czf /backup/sessions.tgz -C /data .` (confira o nome exato do volume com `docker volume ls`).

**Observações:** a imagem usa o **Chromium do Debian** (funciona em servidores Intel/AMD e ARM). Se o QR Code não aparecer, envie o log de `docker compose logs app`.

## F.8 Mudanças que você pode notar

- Login: e-mail não diferencia maiúsculas; 5 erros bloqueiam por 15 min.
- Cadastro: se a cobrança estiver ligada, quem se cadastra **entra para escolher o plano e pagar**; sem cobrança, aguarda sua aprovação.
- Conta vencida: com cobrança ligada, entra só em **Minha assinatura**; sem cobrança, o login é recusado com o motivo.
- Disparos agendados ou em andamento de conta vencida/bloqueada, ou sem cota, **pausam** (aparece o motivo no disparo).
- O menu do dono da conta ganhou **💳 Minha assinatura**.

## F.9 Checklist final de testes (30 minutos)

1. `npm run build` do frontend sem erros.
2. Login (com e-mail em maiúsculas), 👁️ na senha, **Esqueci minha senha** (e-mail chega).
3. Painel: criar plano, criar cliente, definir plano, ver o uso.
4. Cliente: criar 2º WhatsApp no plano com limite 1 → mensagem de limite.
5. Vencer uma conta de teste (data passada) → bloqueia; renovar → volta.
6. **QR Code** em Conexões continua aparecendo.
7. Sandbox do Asaas: cadastro → pagar → liberou sozinho.
8. Celular (ou modo celular do Chrome): percorrer a lista da F.6.

---

# PARTE G — Vender por módulos (planos que liberam só o que o cliente contratou) (v3)

Agora cada plano pode liberar **só algumas partes** do sistema. Exemplos: um plano **só de Disparos**, outro **só de Discador** (para equipes de vendas que já existem) e o **Completo** (mais caro, com tudo). Você monta tudo no painel, sem mexer em código.

## G.1 Os módulos que existem

| Módulo | O que libera | Precisa de |
|---|---|---|
| 👥 Contatos, Listas e Campanhas | Contatos, importação de planilha, listas, campanhas | — |
| 📱 Conexões de WhatsApp | Conectar números (QR Code ou API oficial) | — |
| 💬 Chat | Conversas de WhatsApp | Contatos, Conexões |
| 📋 CRM | Funil Kanban e retornos agendados | Contatos |
| 📣 Disparos em massa | Envio por WhatsApp e e-mail | Contatos, Conexões |
| 📞 Discador para equipes | Discador, fila do vendedor humano, histórico e gravações | Contatos |
| 🤖 Robô de ligações | Ligações automáticas com áudio | Contatos |
| 🧠 Agente de IA por voz | Agentes de IA que ligam e qualificam | Contatos |

**"Precisa de"** significa que, ao marcar um módulo, o painel marca sozinho os que ele exige (não existe Disparos sem Contatos e sem WhatsApp). Sempre liberados, em qualquer plano: Dashboard, Equipe, Configurações e Minha assinatura.

## G.2 Aplicar a atualização

1. Copie os arquivos do pacote por cima do projeto (mesmas pastas), como nas atualizações anteriores.
2. **Banco de dados:** no Supabase → **SQL Editor** → **New query** → cole o conteúdo de `docs/atualizar_banco_modulos_por_plano.sql` → **Run**. (É uma única linha; pode rodar mais de uma vez.)
3. Rode no `backend`: `npx prisma generate` e, no `frontend`, `npm run build`. No servidor, use o seu script de atualização de sempre (`bash deploy/atualizar-servidor.sh` ou `bash deploy/atualizar-docker.sh --banco`).

Planos que você já criou **continuam liberando tudo** até você editá-los (campo vazio = Completo). Nada muda para os clientes atuais.

## G.3 Criando os planos

1. Entre com o seu e-mail de administrador → **🛡️ Administração → aba 💼 Planos e preços**.
2. Clique em **➕ Novo plano**.
3. Preencha nome, preço e cobrança.
4. Em **"O que este plano libera"** escolha:
   - **⭐ Todas as funcionalidades** → plano Completo (o mais caro). Ele também libera módulos novos que você criar no futuro.
   - **📣 Só Disparos**, **📞 Só Discador**, **💬 Chat + CRM** → atalhos prontos que já marcam os módulos.
   - Ou clique em **Escolher módulos um a um** e marque o que quiser.
5. Ajuste os limites (WhatsApps, usuários, mensagens/mês) e clique em **Salvar plano**.
6. Para testar rápido: **✨ Criar planos de exemplo** cria *Só Disparos*, *Discador para Equipes*, *Atendimento + CRM* e *Completo*. Edite preços e limites depois.

A tabela de planos mostra os módulos de cada um. Para dar o plano a um cliente: **Detalhes da conta → 💼 Plano e cobrança → Definir plano** (o efeito é imediato) ou deixe o cliente escolher e pagar em **Minha assinatura**.

## G.4 O que o cliente vê

- No menu, o que **não está** no plano aparece **esmaecido com 🔒**. Ao clicar, abre uma tela explicando que o recurso não está incluído, com atalho para **Ver meu plano**.
- Na página **Ligações**, cada aba é um módulo (Automático = Robô, Vendedor Humano = Discador, Agente IA). As que faltam ficam com 🔒.
- Em **💳 Minha assinatura** há a lista **"O que seu plano inclui"** (✅ / 🔒), e a vitrine de planos mostra os módulos de cada um — bom para vender o upgrade.
- Se você quiser **esconder** em vez de mostrar com cadeado, me peça: é uma mudança pequena no menu.

## G.5 O bloqueio é de verdade (no servidor)

Esconder o botão não bastaria, então o **servidor recusa** qualquer tentativa de usar um módulo fora do plano (mesmo por quem entenda de programação) com a mensagem *"Seu plano não inclui…"*. Além disso:

- **Disparos** agendados/recorrentes e em andamento de quem não tem o módulo **pausam**.
- **Follow-ups automáticos** não são enviados para contas sem Contatos/Conexões.
- **WhatsApp:** ao tirar o módulo de Conexões de um cliente, as sessões abertas dele são **encerradas** e não reabrem.
- Seu usuário de administrador **nunca** é limitado por módulos.

## G.6 Regras para lembrar

- **Mudar um plano muda todos os clientes que estão nele**, na hora. Para um cliente especial, crie um plano só para ele e marque **"Aparece para o cliente escolher"** desligado (fica oculto da vitrine).
- Tirar um módulo **não apaga dados**: contatos, conversas e campanhas continuam guardados; voltam a aparecer se o módulo for liberado de novo.
- **Conta sem plano = tudo liberado** (como era antes). Para restringir, defina um plano.
- Ligações **em andamento** de robô/agente de IA não são interrompidas no meio, mas o cliente não consegue **criar nem iniciar** novas campanhas sem o módulo.

## G.7 Checklist de testes (15 minutos)

1. Rode o SQL e atualize o sistema.
2. Em **Planos e preços**, crie **Só Disparos** com o atalho. Confira que a tabela mostra Disparos, Contatos e Conexões.
3. Crie uma conta de teste (**Clientes → Nova conta**) e defina esse plano.
4. Entre com o usuário de teste (outra janela anônima). Confira: Disparos, Contatos e Conexões abertos; **CRM, Chat, Discador, Ligações com 🔒**.
5. Clique em **CRM** → tela "não incluído no plano".
6. Troque o plano da conta para **Completo** → o cadeado some (pode precisar atualizar a página).
7. Crie **Só Discador** e confira que em **Ligações** só a aba "Vendedor Humano" fica livre.
8. Entre com o seu usuário de administrador: tudo continua liberado.

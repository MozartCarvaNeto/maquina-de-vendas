// backend/src/controllers/authController.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const prisma = require('../config/db');
const env = require('../config/env');
const firebaseReset = require('../services/email/firebaseResetService');
const { sendSystemEmail, buildActionEmail } = require('../services/email/systemMailer');
const { createFailureLimiter, minutesText } = require('../middlewares/rateLimit');
const billingAsaas = require('../services/billing/asaasClient');
const { featuresForAccount } = require('../services/featureService');
const {
  checkMemberAccess,
  isPlatformAdminEmail,
  startOfNextMoment,
  addLog,
  isPaywallEligible
} = require('../services/accessService');

// Proteção contra adivinhação de senha: 5 erros por (IP + e-mail) e 30 por IP, a cada 15 min.
const loginFailures = createFailureLimiter({ windowMs: 15 * 60 * 1000, maxFailures: 5 });
const ipFailures = createFailureLimiter({ windowMs: 15 * 60 * 1000, maxFailures: 30 });
// Hash "falso" para gastar o mesmo tempo quando o e-mail não existe (não revela quem é cliente).
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(8).toString('hex'), 10);

/** Busca ignorando maiúsculas: celulares costumam capitalizar a 1ª letra do e-mail. */
function findMemberByEmail(email, extra = {}) {
  return prisma.member.findFirst({ where: { email: { equals: String(email).trim(), mode: 'insensitive' } }, ...extra });
}

function signToken(memberId) {
  return jwt.sign({ memberId }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
}

function serializeMember(member, accountName) {
  return {
    id: member.id,
    name: member.name,
    email: member.email,
    role: member.role,
    accountId: member.accountId,
    accountName,
    isPlatformAdmin: isPlatformAdminEmail(member.email),
    // Módulos liberados pelo plano da conta (null = todos).
    features: featuresForAccount(member.account, { isPlatformAdmin: isPlatformAdminEmail(member.email) })
  };
}

function serializeAccess(access) {
  return {
    allowed: access.allowed,
    status: access.status,
    plan: access.plan,
    startsAt: access.startsAt,
    endsAt: access.endsAt,
    daysLeft: access.daysLeft,
    inGrace: access.inGrace
  };
}

exports.register = async (req, res, next) => {
  try {
    const { name, email, password, companyName, acceptTerms } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios' });
    }
    if (acceptTerms !== true) {
      return res.status(400).json({ error: 'Para criar a conta é preciso aceitar os Termos de Uso e a Política de Privacidade.', code: 'TERMS_REQUIRED' });
    }
    const legal = await require('../services/legalService').load();
    if (password.length < 6) {
      return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });
    }

    // Cadastro público desligado: só o administrador cria contas (painel /admin).
    if (env.registrationMode === 'closed') {
      return res.status(403).json({
        error: 'Novos cadastros estão desativados. Entre em contato para adquirir seu acesso.',
        code: 'REGISTRATION_CLOSED'
      });
    }

    // E-mails de administrador só podem ser criados pelo script (npm run admin:create),
    // para ninguém "tomar" o painel cadastrando o e-mail antes.
    if (isPlatformAdminEmail(email)) {
      return res.status(400).json({ error: 'Este e-mail é reservado.' });
    }

    const existing = await findMemberByEmail(email);
    if (existing) {
      return res.status(400).json({ error: 'Este e-mail já está cadastrado' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // approval (padrão): nasce "pendente" e só entra depois de aprovada no painel.
    // open: libera na hora (com período de teste se TRIAL_DAYS > 0).
    const now = new Date();
    const accessData =
      env.registrationMode === 'open'
        ? {
            accessStatus: 'ativa',
            subscriptionStartsAt: now,
            subscriptionEndsAt: env.trialDays > 0 ? startOfNextMoment(now, env.trialDays) : null,
            plan: env.trialDays > 0 ? 'Teste grátis' : null
          }
        : { accessStatus: 'pendente' };

    const account = await prisma.account.create({
      data: {
        name: companyName || name,
        termsAcceptedAt: new Date(),
        termsVersion: legal.version,
        termsAcceptedIp: String(req.ip || '').slice(0, 60),
        ...accessData,
        members: {
          create: { name, email, passwordHash, role: 'owner', status: 'ativo' }
        }
      },
      include: { members: true }
    });

    const owner = account.members[0];

    const board = await prisma.crmBoard.create({
      data: {
        userId: account.id,
        name: 'Funil Principal',
        columns: {
          create: [
            { name: 'Novos', position: 0, color: '#00b4d8' },
            { name: 'Em Qualificação', position: 1, color: '#48cae4' },
            { name: 'Qualificado', position: 2, color: '#0096c7' },
            { name: 'Em Negociação', position: 3, color: '#0077b6' },
            { name: 'Fechado', position: 4, color: '#22c55e' },
            { name: 'Perdido', position: 5, color: '#ef4444' }
          ]
        }
      }
    });

    await addLog(
      account.id,
      'cadastro',
      env.registrationMode === 'open' ? 'Cadastro público (liberado automaticamente)' : 'Cadastro público (aguardando aprovação)',
      owner.email
    );

    if (account.accessStatus === 'pendente') {
      const canPay = billingAsaas.isEnabled() && env.autoActivateOnPayment;
      return res.status(201).json({
        pending: true,
        canPay,
        message: canPay
          ? 'Cadastro recebido! Entre com o e-mail e a senha que acabou de criar para escolher seu plano e liberar o acesso.'
          : 'Cadastro recebido! Seu acesso será liberado assim que for aprovado. Você poderá entrar com o e-mail e a senha que acabou de criar.'
      });
    }

    const token = signToken(owner.id);

    res.status(201).json({
      token,
      user: serializeMember(owner, account.name),
      defaultBoardId: board.id
    });
  } catch (error) {
    next(error);
  }
};

exports.login = async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim();
    const { password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'E-mail e senha são obrigatórios' });
    }

    const key = `${req.ip}|${email.toLowerCase()}`;
    const byEmail = loginFailures.check(key);
    const byIp = ipFailures.check(req.ip);
    if (byEmail.blocked || byIp.blocked) {
      const wait = Math.max(byEmail.retryAfterSeconds, byIp.retryAfterSeconds);
      res.set('Retry-After', String(wait));
      return res.status(429).json({
        error: `Muitas tentativas de login. Tente novamente em ${minutesText(wait)} ou use "Esqueci minha senha".`,
        code: 'RATE_LIMITED',
        retryAfterSeconds: wait
      });
    }

    const member = await findMemberByEmail(email, { include: { account: { include: { subscriptionPlan: true } } } });
    // Sempre compara a senha (mesmo sem usuário) para não revelar, pelo tempo de resposta, quem é cliente.
    const validPassword = await bcrypt.compare(password, member ? member.passwordHash : DUMMY_HASH);
    if (!member || !validPassword) {
      loginFailures.fail(key);
      ipFailures.fail(req.ip);
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    loginFailures.reset(key);

    if (member.status !== 'ativo') {
      return res.status(403).json({ error: 'Este usuário está desativado. Fale com o administrador da conta.' });
    }

    // Só depois de a senha estar correta revelamos o motivo do bloqueio
    // (evita que estranhos descubram quais e-mails são clientes).
    const access = checkMemberAccess(member, member.account);
    let restricted = false;
    if (!access.allowed) {
      // Vencida/pendente com cobrança automática: entra, mas só para pagar.
      if (!isPaywallEligible(access)) {
        return res.status(403).json({ error: access.message, code: access.code });
      }
      restricted = true;
    }

    await prisma.member.update({ where: { id: member.id }, data: { lastLoginAt: new Date() } });

    const token = signToken(member.id);

    res.json({
      token,
      restricted,
      user: serializeMember(member, member.account.name),
      access: serializeAccess(access)
    });
  } catch (error) {
    next(error);
  }
};

exports.me = async (req, res, next) => {
  try {
    const member = await prisma.member.findUnique({ where: { id: req.memberId }, include: { account: { include: { subscriptionPlan: true } } } });
    if (!member) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    const legal = await require('../services/legalService').load();
    const isAdmin = isPlatformAdminEmail(member.email);
    res.json({
      user: serializeMember(member, member.account.name),
      access: serializeAccess(checkMemberAccess(member, member.account)),
      terms: { version: legal.version, acceptedVersion: member.account.termsVersion || null, needsAccept: !isAdmin && member.account.termsVersion !== legal.version }
    });
  } catch (error) {
    next(error);
  }
};

exports.acceptTerms = async (req, res, next) => {
  try {
    const legal = await require('../services/legalService').load();
    await prisma.account.update({ where: { id: req.userId }, data: { termsAcceptedAt: new Date(), termsVersion: legal.version, termsAcceptedIp: String(req.ip || '').slice(0, 60) } });
    res.json({ success: true, version: legal.version });
  } catch (error) {
    next(error);
  }
};

exports.forgotPassword = async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim();
    if (!email) {
      return res.status(400).json({ error: 'E-mail é obrigatório' });
    }

    // Resposta SEMPRE igual, exista o e-mail ou não (não revela quem é cliente).
    const genericResponse = {
      success: true,
      message:
        'Se este e-mail estiver cadastrado, você receberá o link para criar uma nova senha em instantes. Confira também a caixa de spam.',
      supportContact: env.supportContact || null
    };

    const member = await findMemberByEmail(email);
    if (!member) {
      return res.json(genericResponse);
    }

    // 1) Link próprio, enviado pelo e-mail do sistema (SMTP do sistema, depois e-mail da conta, depois e-mail do administrador).
    const resetSvc = require('../services/email/passwordResetService');
    const resetUrl = await resetSvc.issueLink(member);
    let delivery = await resetSvc.sendLink(member, resetUrl);

    // 2) Se nenhum e-mail do sistema funcionou, tenta o Firebase como reserva.
    if (!delivery.ok && firebaseReset.isConfigured()) {
      try {
        await firebaseReset.sendPasswordReset(member.email);
        delivery = { ok: true, via: 'firebase' };
      } catch (fbError) {
        console.error(`⚠️ Firebase também não enviou a redefinição (${fbError.message}).`);
        delivery.error = `${delivery.error} | Firebase: ${fbError.message}`;
      }
    }
    if (!delivery.ok) {
      console.error(`❌ Não foi possível enviar e-mail de redefinição para ${member.email}: ${delivery.error}. Teste em Administração > E-mail do sistema.`);
    }

    // Registra no histórico da conta e avisa o administrador (sem atrasar a resposta ao visitante).
    addLog(member.accountId, 'senha_pedido', delivery.ok ? `Link enviado a ${member.email} (${delivery.via})` : `Falha ao enviar a ${member.email}: ${String(delivery.error || '').slice(0, 180)}`, member.email).catch(() => {});
    if (!isPlatformAdminEmail(member.email)) {
      resetSvc.notifyAdmins(member, delivery, { ip: String(req.ip || ''), url: resetUrl }).catch(() => {});
    }

    res.json(genericResponse);
  } catch (error) {
    next(error);
  }
};

exports.resetPassword = async (req, res, next) => {
  try {
    const { token, oobCode, newPassword } = req.body;

    if ((!token && !oobCode) || !newPassword) {
      return res.status(400).json({ error: 'Link e newPassword são obrigatórios' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'A nova senha deve ter pelo menos 6 caracteres' });
    }

    // Link enviado pelo Firebase (código de uso único).
    if (oobCode) {
      if (!firebaseReset.isConfigured()) {
        return res.status(400).json({ error: 'Link de redefinição inválido. Solicite um novo.' });
      }
      let email;
      try {
        email = await firebaseReset.consumeOobCode(String(oobCode));
      } catch (e) {
        return res.status(400).json({ error: 'Link de redefinição inválido ou expirado. Solicite um novo.' });
      }
      const fbMember = email ? await findMemberByEmail(email) : null;
      if (!fbMember) {
        return res.status(400).json({ error: 'Link de redefinição inválido ou expirado. Solicite um novo.' });
      }
      await prisma.member.update({
        where: { id: fbMember.id },
        data: { passwordHash: await bcrypt.hash(newPassword, 10), resetToken: null, resetTokenExpiresAt: null }
      });
      return res.json({ success: true, message: 'Senha redefinida com sucesso. Você já pode fazer login.' });
    }

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const member = await prisma.member.findFirst({
      where: { resetToken: hashedToken, resetTokenExpiresAt: { gt: new Date() } }
    });

    if (!member) {
      return res.status(400).json({ error: 'Link de redefinição inválido ou expirado. Solicite um novo.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    await prisma.member.update({
      where: { id: member.id },
      data: { passwordHash, resetToken: null, resetTokenExpiresAt: null }
    });

    res.json({ success: true, message: 'Senha redefinida com sucesso. Você já pode fazer login.' });
  } catch (error) {
    next(error);
  }
};
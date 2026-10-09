// backend/src/middlewares/auth.js
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const prisma = require('../config/db');
const { checkMemberAccess, isPlatformAdminEmail, isPaywallEligible } = require('../services/accessService');
const { featuresForAccount } = require('../services/featureService');

// Conta vencida pode usar SÓ estas rotas (tela de pagamento).
const PAYWALL_PATHS = ['/api/billing', '/api/auth/me'];

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'Token não informado' });
    }

    const decoded = jwt.verify(token, env.jwtSecret);
    const member = await prisma.member.findUnique({
      where: { id: decoded.memberId },
      include: { account: { include: { subscriptionPlan: true } } }
    });

    if (!member || member.status !== 'ativo') {
      return res.status(401).json({ error: 'Sessão inválida. Faça login novamente.' });
    }

    // Controle de assinatura: a cada requisição confere se a conta está
    // liberada (aprovada, não bloqueada e dentro do prazo). Administradores
    // da plataforma nunca são bloqueados.
    const access = checkMemberAccess(member, member.account);
    if (!access.allowed) {
      const url = req.originalUrl || '';
      const canOnlyPay = isPaywallEligible(access) && PAYWALL_PATHS.some((p) => url.startsWith(p));
      if (!canOnlyPay) {
        return res.status(403).json({ error: access.message, code: access.code });
      }
      req.restricted = true;
    }
    req.access = access;
    req.isPlatformAdmin = isPlatformAdminEmail(member.email);
    // Módulos liberados pelo plano (null = todos). Usado por requireFeature().
    req.features = featuresForAccount(member.account, { isPlatformAdmin: req.isPlatformAdmin });

    // req.userId continua representando a CONTA (accountId) — exatamente como
    // antes representava o dono dos dados. Por isso nenhum outro controller
    // do sistema (leads, crm, campanhas, whatsapp, discador, listas, disparos)
    // precisou ser alterado nesta mudança para multiusuário.
    req.userId = member.accountId;
    req.memberId = member.id;
    req.memberRole = member.role;
    req.member = { id: member.id, name: member.name, email: member.email, role: member.role };

    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}

module.exports = auth;
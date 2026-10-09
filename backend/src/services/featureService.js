// backend/src/services/featureService.js
//
// MÓDULOS (funcionalidades) que cada plano libera. É aqui que você define quais
// partes do sistema existem para vender separadamente.
//
// Regras:
//  - Plano com `features` vazio/nulo (null)  = TODOS os módulos (plano completo).
//  - Conta SEM plano                          = todos os módulos (comportamento antigo).
//  - Administrador da plataforma              = sempre todos.
//  - Um módulo pode exigir outros (ex.: Disparos precisa de Contatos e Conexões);
//    ao salvar o plano, os exigidos são marcados automaticamente.
//
// Para criar um módulo novo no futuro: adicione uma linha em FEATURES, proteja as
// rotas com requireFeature('chave') e coloque a chave no menu do frontend.
const prisma = require('../config/db');
const { isPlatformAdminEmail } = require('./accessService');

const FEATURES = [
  {
    key: 'contatos',
    label: 'Contatos, Listas e Campanhas',
    icon: '👥',
    description: 'Base de contatos, importação de planilhas, listas segmentadas e campanhas. É a base dos demais módulos.',
    requires: []
  },
  {
    key: 'conexoes',
    label: 'Conexões de WhatsApp',
    icon: '📱',
    description: 'Conectar números de WhatsApp (QR Code ou API oficial).',
    requires: []
  },
  {
    key: 'chat',
    label: 'Chat (atendimento WhatsApp)',
    icon: '💬',
    description: 'Conversas de WhatsApp em tempo real com os clientes.',
    requires: ['contatos', 'conexoes']
  },
  {
    key: 'crm',
    label: 'CRM (funil de vendas)',
    icon: '📋',
    description: 'Quadros Kanban, retornos agendados e acompanhamento de negociações.',
    requires: ['contatos']
  },
  {
    key: 'disparos',
    label: 'Disparos em massa',
    icon: '📣',
    description: 'Envio em massa e agendado por WhatsApp e e-mail.',
    requires: ['contatos', 'conexoes']
  },
  {
    key: 'discador',
    label: 'Discador para equipes de vendas',
    icon: '📞',
    description: 'Discador, fila de ligações do vendedor humano, histórico e gravações.',
    requires: ['contatos']
  },
  {
    key: 'robo',
    label: 'Robô de ligações',
    icon: '🤖',
    description: 'Ligações automáticas com áudio e qualificação por teclado.',
    requires: ['contatos']
  },
  {
    key: 'agente_ia',
    label: 'Agente de IA por voz',
    icon: '🧠',
    description: 'Agentes de IA que conversam por telefone, qualificam e chamam o vendedor.',
    requires: ['contatos']
  }
];

const KEYS = FEATURES.map((f) => f.key);
const BY_KEY = Object.fromEntries(FEATURES.map((f) => [f.key, f]));

/**
 * Valida a lista vinda do painel. Retorna:
 *   { features: null }        → plano completo (todos os módulos)
 *   { features: ['crm', ...] } → módulos escolhidos, já com dependências incluídas
 *   { error }                  → entrada inválida
 */
function normalizeFeatures(input) {
  if (input === null || input === undefined || input === '' || input === 'all') return { features: null };
  if (!Array.isArray(input)) return { error: 'Módulos inválidos.' };

  const wanted = new Set();
  for (const raw of input) {
    const key = String(raw);
    if (!BY_KEY[key]) return { error: `Módulo desconhecido: ${key}` };
    wanted.add(key);
  }
  if (wanted.size === 0) return { error: 'Marque pelo menos um módulo no plano (ou use "Todas as funcionalidades").' };

  // Inclui as dependências (recursivo, com proteção contra ciclo).
  const queue = [...wanted];
  while (queue.length) {
    const key = queue.pop();
    for (const dep of BY_KEY[key].requires) {
      if (!wanted.has(dep)) {
        wanted.add(dep);
        queue.push(dep);
      }
    }
  }
  const all = KEYS.every((k) => wanted.has(k));
  return { features: all ? null : KEYS.filter((k) => wanted.has(k)) };
}

/** Lê o campo JSON do plano e devolve null (todos) ou um array de chaves válidas. */
function planFeatureList(plan) {
  if (!plan || plan.features === null || plan.features === undefined) return null;
  if (!Array.isArray(plan.features)) return null;
  const list = plan.features.filter((k) => BY_KEY[k]);
  return list.length ? list : null;
}

/** Módulos liberados para uma conta carregada com `subscriptionPlan`. null = todos. */
function featuresForAccount(account, { isPlatformAdmin = false } = {}) {
  if (isPlatformAdmin) return null;
  return planFeatureList(account?.subscriptionPlan);
}

/** `features` é null (todos) ou lista; basta UM dos módulos pedidos. */
function hasAny(features, keys) {
  if (features === null || features === undefined) return true;
  return keys.some((k) => features.includes(k));
}

/** Resolve pelo banco (para jobs/serviços que só têm o accountId). */
async function accountHasFeature(accountId, ...keys) {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: { subscriptionPlan: true, members: { select: { email: true } } }
  });
  if (!account) return false;
  const isAdmin = account.members.some((m) => isPlatformAdminEmail(m.email));
  return hasAny(featuresForAccount(account, { isPlatformAdmin: isAdmin }), keys);
}

/** Contas cujo plano NÃO inclui o módulo (para jobs filtrarem). Admins da plataforma nunca entram. */
async function getAccountIdsWithoutFeature(key) {
  const accounts = await prisma.account.findMany({
    where: { planId: { not: null } },
    include: { subscriptionPlan: true, members: { select: { email: true } } }
  });
  return accounts
    .filter((a) => !a.members.some((m) => isPlatformAdminEmail(m.email)))
    .filter((a) => !hasAny(planFeatureList(a.subscriptionPlan), [key]))
    .map((a) => a.id);
}

/** Catálogo enviado ao frontend. */
function catalog() {
  return FEATURES.map((f) => ({ key: f.key, label: f.label, icon: f.icon, description: f.description, requires: f.requires }));
}

/** Middleware: exige que o plano da conta inclua UM dos módulos. Usar DEPOIS do `auth`. */
function requireFeature(...keys) {
  return (req, res, next) => {
    if (req.isPlatformAdmin || hasAny(req.features, keys)) return next();
    const first = BY_KEY[keys[0]];
    return res.status(403).json({
      error: `Seu plano não inclui ${first ? `o módulo "${first.label}"` : 'esta funcionalidade'}. Fale com o suporte para contratar.`,
      code: 'FEATURE_LOCKED',
      feature: keys[0]
    });
  };
}

module.exports = {
  FEATURES,
  KEYS,
  catalog,
  normalizeFeatures,
  planFeatureList,
  featuresForAccount,
  hasAny,
  accountHasFeature,
  getAccountIdsWithoutFeature,
  requireFeature
};

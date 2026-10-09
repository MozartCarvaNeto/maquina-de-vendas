// backend/src/services/leadListService.js
const prisma = require('../config/db');

/**
 * Resolve os leads que atendem às regras de uma lista DINÂMICA.
 * Formato esperado de filterRules (JSON salvo em LeadList.filterRules):
 * {
 *   "status": "qualificado",           // opcional: filtra pelo status do funil
 *   "campaignId": "uuid-da-campanha",  // opcional
 *   "tagsAll": ["visitou_site"],       // opcional: precisa ter TODAS estas tags
 *   "tagsAny": ["vip", "recorrente"],  // opcional: precisa ter QUALQUER uma destas tags
 *   "excludeTags": ["comprou"],        // opcional: NÃO pode ter nenhuma destas tags
 *   "lastPurchaseWithinDays": 30,      // opcional: comprou nos últimos N dias
 *   "neverPurchased": true             // opcional: nunca comprou (lastPurchaseAt é nulo)
 * }
 *
 * Exemplo prático 1 — "visitou o site e não comprou":
 * { "tagsAll": ["visitou_site"], "excludeTags": ["comprou"] }
 *
 * Exemplo prático 2 — "comprou nos últimos 30 dias":
 * { "lastPurchaseWithinDays": 30 }
 */
function buildDynamicWhere(userId, filterRules) {
  const where = { userId, optOut: false };
  const rules = filterRules || {};

  if (rules.status) {
    where.status = rules.status;
  }
  if (rules.campaignId) {
    where.campaignId = rules.campaignId;
  }
  if (rules.tagsAll && rules.tagsAll.length > 0) {
    where.tags = { hasEvery: rules.tagsAll };
  }
  if (rules.tagsAny && rules.tagsAny.length > 0) {
    where.tags = { ...(where.tags || {}), hasSome: rules.tagsAny };
  }
  if (rules.excludeTags && rules.excludeTags.length > 0) {
    where.NOT = { tags: { hasSome: rules.excludeTags } };
  }
  if (rules.lastPurchaseWithinDays) {
    const since = new Date(Date.now() - rules.lastPurchaseWithinDays * 24 * 60 * 60 * 1000);
    where.lastPurchaseAt = { gte: since };
  }
  if (rules.neverPurchased) {
    where.lastPurchaseAt = null;
  }

  return where;
}

/**
 * `opts.select` permite buscar só as colunas necessárias (reduz o tráfego
 * de saída do banco — cada lead completo tem várias colunas e listas grandes
 * multiplicam isso).
 */
async function resolveDynamicFilter(userId, filterRules, opts = {}) {
  const where = buildDynamicWhere(userId, filterRules);
  return prisma.lead.findMany({ where, ...(opts.select ? { select: opts.select } : {}) });
}

/**
 * Condição (where de Lead) equivalente aos membros de uma lista, estática
 * ou dinâmica. Permite contar/paginar no banco sem trazer os leads.
 */
function buildListLeadWhere(userId, list) {
  if (list.type === 'static') {
    return { optOut: false, listMemberships: { some: { listId: list.id } } };
  }
  return buildDynamicWhere(userId, list.filterRules);
}

/**
 * Resolve os membros de uma lista, seja ela estática (membros fixos)
 * ou dinâmica (recalculada na hora a partir das regras).
 */
async function resolveListMembers(userId, list, opts = {}) {
  if (list.type === 'static') {
    const memberships = await prisma.leadListMembership.findMany({
      where: { listId: list.id, lead: { optOut: false } },
      include: { lead: opts.select ? { select: opts.select } : true }
    });
    return memberships.map((m) => m.lead);
  }

  return resolveDynamicFilter(userId, list.filterRules, opts);
}

module.exports = { resolveListMembers, resolveDynamicFilter, buildListLeadWhere };
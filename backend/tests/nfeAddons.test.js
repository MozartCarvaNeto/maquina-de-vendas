// Pacotes de NF-e (notas extras e espaço) e NF-e inclusa no plano principal.
// Rode com:  node tests/nfeAddons.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const db = { sub: null, account: null, purchases: [] };
const prisma = {
  nfeSubscription: { findUnique: async () => db.sub },
  account: { findUnique: async () => db.account },
  nfeAddonPurchase: {
    findMany: async () => db.purchases.filter((p) => p.status === 'paid' && p.expiresAt > new Date()),
    findUnique: async ({ where }) => db.purchases.find((p) => p.id === where.id) || null,
    updateMany: async ({ where, data }) => {
      const p = db.purchases.find((x) => x.id === where.id && x.status !== 'paid');
      if (!p) return { count: 0 };
      Object.assign(p, data);
      return { count: 1 };
    }
  }
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === '../../config/db') return prisma;
  if (req === '../../config/env') return { graceDays: 3, nfe: { secret: 'segredo-de-teste', storageBaseMb: 1000 } };
  if (req === '../config/env') return { nfe: { secret: 'segredo-de-teste', storageBaseMb: 1000 } };
  if (req === '../accessService') return { addLog: async () => {}, isPlatformAdminEmail: () => false };
  if (req === '../billing/asaasClient') return { isEnabled: () => false };
  if (req === '../billing/billingService') return { addMonths: (d, m) => { const x = new Date(d); x.setMonth(x.getMonth() + m); return x; }, CYCLE_BY_MONTHS: {} };
  return origLoad.call(this, req, ...rest);
};
process.env.NFE_INTERNAL_SECRET = 'segredo-de-teste';
const svc = require('../src/services/nfe/nfeService');
const bridge = require('../src/services/nfe/nfeBridge');
Module._load = origLoad;

const reset = () => { db.sub = null; db.account = null; db.purchases = []; };
const future = () => new Date(Date.now() + 10 * 24 * 3600 * 1000);

test('sem plano nenhum: sem_plano', async () => {
  reset();
  assert.equal((await svc.getState('a1')).status, 'sem_plano');
});

test('NF-e inclusa no plano principal libera o emissor e usa os limites do plano', async () => {
  reset();
  db.account = { id: 'a1', subscriptionPlan: { name: 'Completo', nfeIncluded: true, nfeMonthlyNotes: 200, nfeStorageMb: 2000 } };
  const s = await svc.getState('a1');
  assert.equal(s.status, 'ativa');
  assert.equal(s.source, 'plano');
  assert.equal(s.limit, 200);
  assert.equal(s.storageMb, 2000);
});

test('pacotes ativos somam notas e espaço; expirados não contam', async () => {
  reset();
  db.account = { id: 'a1', subscriptionPlan: { name: 'Completo', nfeIncluded: true, nfeMonthlyNotes: 100, nfeStorageMb: 1000 } };
  db.purchases = [
    { id: 'p1', kind: 'notes', amount: 50, status: 'paid', expiresAt: future() },
    { id: 'p2', kind: 'storage', amount: 200, status: 'paid', expiresAt: future() },
    { id: 'p3', kind: 'storage', amount: 999, status: 'paid', expiresAt: new Date(Date.now() - 1000) }
  ];
  const s = await svc.getState('a1');
  assert.equal(s.limit, 150);
  assert.equal(s.storageMb, 1200);
});

test('plano ilimitado continua ilimitado com pacote', async () => {
  reset();
  db.account = { id: 'a1', subscriptionPlan: { name: 'X', nfeIncluded: true, nfeMonthlyNotes: null, nfeStorageMb: null } };
  db.purchases = [{ id: 'p1', kind: 'notes', amount: 50, status: 'paid', expiresAt: future() }];
  assert.equal((await svc.getState('a1')).limit, null);
});

test('administrador da plataforma: sem limites', async () => {
  const s = await svc.getState('x', { isPlatformAdmin: true });
  assert.equal(s.limit, null);
  assert.equal(s.storageMb, null);
});

test('pagamento de pacote: libera uma vez só, de notas vale até o fim do mês, valor menor é ignorado', async () => {
  reset();
  db.purchases = [
    { id: 'n1', accountId: 'a1', kind: 'notes', name: '+100', priceCents: 1000, status: 'pending', addon: { validMonths: 12 } },
    { id: 's1', accountId: 'a1', kind: 'storage', name: '+100MB', priceCents: 2000, status: 'pending', addon: { validMonths: 6 } }
  ];
  const pay = (id, value) => ({ id: `pay_${id}`, externalReference: `nfeaddon:${id}`, value });
  assert.equal((await svc.applyAddonPaid(pay('n1', 5))).status, 'ignored');
  const r = await svc.applyAddonPaid(pay('n1', 10));
  assert.equal(r.status, 'applied');
  const d = r.expiresAt;
  assert.equal(d.getTime() > Date.now(), true);
  assert.equal(d.getTime() - Date.now() < 32 * 24 * 3600 * 1000, true);
  assert.equal((await svc.applyAddonPaid(pay('n1', 10))).status, 'duplicate');
  const r2 = await svc.applyAddonPaid(pay('s1', 20));
  const meses = (r2.expiresAt.getTime() - Date.now()) / (30 * 24 * 3600 * 1000);
  assert.equal(meses > 5 && meses < 7, true);
});

test('cabeçalhos assinados para o emissor incluem o espaço', () => {
  const h = bridge.signHeaders({ accountId: 'a1', userEmail: 'u@x.com', role: 'owner', limit: 10, readOnly: false, storageMb: 1200.7 });
  assert.equal(h['X-Turbo-Storage-Mb'], '1200');
  const sem = bridge.signHeaders({ accountId: 'a1', userEmail: 'u@x.com', role: 'owner', limit: null, readOnly: false, storageMb: null });
  assert.equal(sem['X-Turbo-Storage-Mb'], '');
  assert.notEqual(h['X-Turbo-Sig'], sem['X-Turbo-Sig']);
});

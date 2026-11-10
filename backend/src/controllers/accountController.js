// backend/src/controllers/accountController.js
// Conta do cliente: dados fiscais, recibos, primeiro acesso, uso do plano e lista de bloqueio.
const prisma = require('../config/db');
const legal = require('../services/legalService');
const onboarding = require('../services/onboardingService');
const optOuts = require('../services/optOutService');
const planService = require('../services/planService');
const telecom = require('../services/telecomLimitService');

const digits = (v) => String(v || '').replace(/\D/g, '');

/** Valida CPF/CNPJ pelos dígitos verificadores. */
function validTaxId(v) {
  const d = digits(v);
  if (d.length === 11) {
    if (/^(\d)\1+$/.test(d)) return false;
    const calc = (n) => { let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
    return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
  }
  if (d.length === 14) {
    if (/^(\d)\1+$/.test(d)) return false;
    const calc = (n) => { const w = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * w[i]; const r = s % 11; return r < 2 ? 0 : 11 - r; };
    return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
  }
  return false;
}

exports.legalPublic = async (req, res, next) => {
  try {
    const l = await legal.load();
    res.json({ version: l.version, company: l.company, terms: l.terms, privacy: l.privacy });
  } catch (e) { next(e); }
};

exports.adminLegalGet = async (req, res, next) => {
  try { res.json(await legal.load(true)); } catch (e) { next(e); }
};
exports.adminLegalSave = async (req, res, next) => {
  try { res.json(await legal.save(req.body || {})); } catch (e) { next(e); }
};

// ----- dados fiscais -----
const fiscalOf = (a) => ({ legalName: a.legalName || '', taxId: a.taxId || '', fiscalEmail: a.fiscalEmail || '', fiscalAddress: a.fiscalAddress || '' });

exports.getFiscal = async (req, res, next) => {
  try {
    const a = await prisma.account.findUnique({ where: { id: req.userId } });
    res.json(fiscalOf(a || {}));
  } catch (e) { next(e); }
};

exports.saveFiscal = async (req, res, next) => {
  try {
    const b = req.body || {};
    const data = {};
    if (b.legalName !== undefined) data.legalName = String(b.legalName).trim().slice(0, 160) || null;
    if (b.taxId !== undefined) {
      const d = digits(b.taxId);
      if (d && !validTaxId(d)) return res.status(400).json({ error: 'CPF ou CNPJ inválido. Confira os números.' });
      data.taxId = d || null;
    }
    if (b.fiscalEmail !== undefined) {
      const e = String(b.fiscalEmail).trim().toLowerCase();
      if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return res.status(400).json({ error: 'E-mail fiscal inválido.' });
      data.fiscalEmail = e || null;
    }
    if (b.fiscalAddress !== undefined) data.fiscalAddress = String(b.fiscalAddress).trim().slice(0, 300) || null;
    const a = await prisma.account.update({ where: { id: req.userId }, data });
    res.json(fiscalOf(a));
  } catch (e) { next(e); }
};

// ----- recibos -----
async function paidItems(accountId) {
  const [pays, tops] = await Promise.all([
    prisma.billingPayment.findMany({ where: { accountId, paidAt: { not: null } }, orderBy: { paidAt: 'desc' }, take: 200 }),
    prisma.walletTopup.findMany({ where: { accountId, status: 'paid' }, orderBy: { paidAt: 'desc' }, take: 200 })
  ]);
  const items = [
    ...pays.map((p) => ({ kind: 'plano', id: p.id, description: 'Mensalidade do plano', amount: p.amountCents / 100, paidAt: p.paidAt, nfseNumber: p.nfseNumber || null, nfseUrl: p.nfseUrl || null, invoiceUrl: p.invoiceUrl || null })),
    ...tops.map((t) => ({ kind: 'recarga', id: t.id, description: 'Recarga de saldo', amount: t.amountCents / 100, paidAt: t.paidAt, nfseNumber: t.nfseNumber || null, nfseUrl: t.nfseUrl || null, invoiceUrl: t.invoiceUrl || null }))
  ];
  return items.sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));
}

const receiptNo = (it) => `REC-${new Date(it.paidAt).toISOString().slice(0, 10).replace(/-/g, '')}-${String(it.id).replace(/-/g, '').slice(0, 6).toUpperCase()}`;

exports.receipts = async (req, res, next) => {
  try {
    const items = await paidItems(req.userId);
    res.json({ receipts: items.map((i) => ({ ...i, number: receiptNo(i) })) });
  } catch (e) { next(e); }
};

exports.receipt = async (req, res, next) => {
  try {
    const items = await paidItems(req.userId);
    const it = items.find((i) => i.kind === req.params.kind && i.id === req.params.id);
    if (!it) return res.status(404).json({ error: 'Recibo não encontrado.' });
    const [a, l] = await Promise.all([prisma.account.findUnique({ where: { id: req.userId } }), legal.load()]);
    res.json({
      receipt: { ...it, number: receiptNo(it) },
      seller: l.company,
      customer: { name: a.legalName || a.name, taxId: a.taxId || '', email: a.fiscalEmail || '', address: a.fiscalAddress || '' },
      notice: 'Recibo de pagamento. Não substitui a nota fiscal de serviço; quando emitida, o número aparece acima.'
    });
  } catch (e) { next(e); }
};

// ----- uso do plano -----
exports.planUsage = async (req, res, next) => {
  try {
    const [limits, usage, tel] = await Promise.all([planService.getAccountLimits(req.userId), planService.getUsage(req.userId), telecom.usage(req.userId)]);
    res.json({ limits, usage: { ...usage, ...tel } });
  } catch (e) { next(e); }
};

// ----- primeiro acesso -----
exports.onboarding = async (req, res, next) => {
  try { res.json(await onboarding.steps(req.userId, { isPlatformAdmin: !!req.isPlatformAdmin })); } catch (e) { next(e); }
};
exports.onboardingDismiss = async (req, res, next) => {
  try { await onboarding.dismiss(req.userId, req.body?.dismissed !== false); res.json({ success: true }); } catch (e) { next(e); }
};

// ----- lista de bloqueio -----
exports.optOutList = async (req, res, next) => {
  try { res.json(await optOuts.list(req.userId, { q: req.query.q })); } catch (e) { next(e); }
};
exports.optOutAdd = async (req, res, next) => {
  try {
    const b = req.body || {};
    if (b.numbers) return res.json({ success: true, ...(await optOuts.importMany(req.userId, b.numbers, { channel: b.channel || 'all', reason: b.reason || 'Importado' })) });
    const row = await optOuts.add(req.userId, b.phone, { channel: b.channel || 'all', source: 'manual', reason: b.reason });
    res.status(201).json({ item: row });
  } catch (e) { next(e); }
};
exports.optOutRemove = async (req, res, next) => {
  try { await optOuts.remove(req.userId, req.params.id); res.json({ success: true }); } catch (e) { next(e); }
};

// ----- administrador: financeiro e notas -----
exports.adminRevenue = async (req, res, next) => {
  try { res.json(await require('../services/revenueMetricsService').overview({ months: Number(req.query.months) || 6 })); } catch (e) { next(e); }
};

exports.adminFiscalList = async (req, res, next) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : new Date().toISOString().slice(0, 7);
    const from = new Date(`${month}-01T00:00:00Z`);
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    const [pays, tops] = await Promise.all([
      prisma.billingPayment.findMany({ where: { paidAt: { gte: from, lt: to } }, orderBy: { paidAt: 'asc' } }),
      prisma.walletTopup.findMany({ where: { status: 'paid', paidAt: { gte: from, lt: to } }, orderBy: { paidAt: 'asc' } })
    ]);
    const ids = [...new Set([...pays, ...tops].map((x) => x.accountId))];
    const accs = new Map((await prisma.account.findMany({ where: { id: { in: ids } } })).map((a) => [a.id, a]));
    const rows = [
      ...pays.map((p) => ({ kind: 'plano', id: p.id, accountId: p.accountId, amount: p.amountCents / 100, paidAt: p.paidAt, nfseNumber: p.nfseNumber || '', nfseUrl: p.nfseUrl || '' })),
      ...tops.map((t) => ({ kind: 'recarga', id: t.id, accountId: t.accountId, amount: t.amountCents / 100, paidAt: t.paidAt, nfseNumber: t.nfseNumber || '', nfseUrl: t.nfseUrl || '' }))
    ].sort((a, b) => new Date(a.paidAt) - new Date(b.paidAt)).map((r) => {
      const a = accs.get(r.accountId) || {};
      return { ...r, customer: a.legalName || a.name || r.accountId, taxId: a.taxId || '', address: a.fiscalAddress || '', email: a.fiscalEmail || '', dataOk: !!(a.taxId && a.legalName) };
    });
    if (String(req.query.format) === 'csv') {
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const head = ['Data', 'Tipo', 'Valor', 'Cliente', 'CPF/CNPJ', 'E-mail', 'Endereço', 'Nota (número)', 'Nota (link)'];
      const csv = [head.join(';'), ...rows.map((r) => [new Date(r.paidAt).toLocaleDateString('pt-BR'), r.kind, r.amount.toFixed(2).replace('.', ','), r.customer, r.taxId, r.email, r.address, r.nfseNumber, r.nfseUrl].map(esc).join(';'))].join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="faturamento-${month}.csv"`);
      return res.send('﻿' + csv);
    }
    res.json({ month, total: rows.reduce((s, r) => s + r.amount, 0), pendingInvoice: rows.filter((r) => !r.nfseNumber).length, rows });
  } catch (e) { next(e); }
};

exports.adminFiscalMark = async (req, res, next) => {
  try {
    const { kind, id } = req.params;
    const data = { nfseNumber: String(req.body?.nfseNumber || '').trim().slice(0, 60) || null, nfseUrl: String(req.body?.nfseUrl || '').trim().slice(0, 500) || null };
    if (data.nfseUrl && !/^https?:\/\//i.test(data.nfseUrl)) return res.status(400).json({ error: 'O link da nota deve começar com http:// ou https://.' });
    const model = kind === 'plano' ? prisma.billingPayment : kind === 'recarga' ? prisma.walletTopup : null;
    if (!model) return res.status(400).json({ error: 'Tipo inválido.' });
    await model.update({ where: { id }, data });
    res.json({ success: true });
  } catch (e) { next(e); }
};

exports._validTaxId = validTaxId;

// backend/src/controllers/leadSearchController.js
const prisma = require('../config/db');
const service = require('../services/leadSearchService');
const { findEmails } = require('../services/leadSearch/emailFinder');
const { normalizePhone } = require('../services/leadSearch/phoneUtils');

const clip = (v, n) => String(v ?? '').trim().slice(0, n);

exports.status = async (req, res, next) => {
  try {
    res.json({ google: Boolean(await service.getGoogleKey(req.userId)), openstreetmap: true });
  } catch (error) {
    next(error);
  }
};

exports.saveKey = async (req, res, next) => {
  try {
    const apiKey = clip(req.body?.apiKey, 200);
    if (apiKey.length < 20) return res.status(400).json({ error: 'Chave inválida. Cole a chave completa do Google Maps (Places API).' });
    await service.saveGoogleKey(req.userId, apiKey);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

exports.removeKey = async (req, res, next) => {
  try {
    await service.removeGoogleKey(req.userId);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

exports.search = async (req, res, next) => {
  try {
    const query = clip(req.body?.query, 80);
    const location = clip(req.body?.location, 80);
    if (query.length < 3) return res.status(400).json({ error: 'Digite o ramo de atividade (ex: clínica odontológica).' });
    if (location.length < 2) return res.status(400).json({ error: 'Digite a cidade ou o estado (ex: Campinas SP).' });
    const source = req.body?.source === 'openstreetmap' ? 'openstreetmap' : 'google';
    const limit = Math.min(60, Math.max(5, parseInt(req.body?.limit, 10) || 40));

    const results = await service.search({ userId: req.userId, source, query, location, limit });
    res.json({
      results,
      total: results.length,
      withPhone: results.filter((r) => r.phone).length,
      withEmail: results.filter((r) => r.email).length
    });
  } catch (error) {
    next(error);
  }
};

/** Procura e-mails nos sites de um lote (a tela chama em lotes de ~10 e mostra o progresso). */
exports.enrich = async (req, res, next) => {
  try {
    const items = (Array.isArray(req.body?.items) ? req.body.items : [])
      .slice(0, 15)
      .map((i) => ({ id: clip(i.id, 80), website: clip(i.website, 300) }))
      .filter((i) => i.id && i.website);
    const emails = await findEmails(items);
    res.json({ emails });
  } catch (error) {
    next(error);
  }
};

/** Salva as empresas escolhidas como contatos e as coloca numa lista com o nome que o usuário definiu. */
exports.importSelected = async (req, res, next) => {
  try {
    const listName = clip(req.body?.listName, 80);
    if (!listName) return res.status(400).json({ error: 'Dê um nome para a lista (ex: Dentistas Campinas).' });
    const items = (Array.isArray(req.body?.items) ? req.body.items : []).slice(0, 200);
    if (!items.length) return res.status(400).json({ error: 'Selecione pelo menos uma empresa.' });

    const segment = clip(req.body?.segment, 60);
    const extraTags = (Array.isArray(req.body?.tags) ? req.body.tags : []).map((t) => clip(t, 40)).filter(Boolean).slice(0, 10);
    const tags = [...new Set(['b2b', 'busca-empresas', ...(segment ? [segment.toLowerCase()] : []), ...extraTags])];

    const prepared = [];
    for (const item of items) {
      const name = clip(item.name, 150);
      const phone = normalizePhone(item.phone);
      const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(item.email || '')) ? clip(item.email, 120).toLowerCase() : null;
      if (!name || (!phone && !email)) continue;
      prepared.push({ name, phone, email, address: clip(item.address, 250) || null });
    }
    if (!prepared.length) return res.status(400).json({ error: 'Nenhuma empresa selecionada tem telefone ou e-mail.' });

    // Quem já existe (mesmo telefone ou e-mail) não é duplicado: só entra na lista.
    const existing = await prisma.lead.findMany({
      where: {
        userId: req.userId,
        OR: [
          ...prepared.filter((p) => p.phone).map((p) => ({ phone: { endsWith: p.phone.replace(/\D/g, '').slice(-8) } })),
          ...prepared.filter((p) => p.email).map((p) => ({ email: { equals: p.email, mode: 'insensitive' } }))
        ]
      },
      select: { id: true, phone: true, email: true }
    });
    const byPhone = new Map(existing.filter((l) => l.phone).map((l) => [l.phone.replace(/\D/g, '').slice(-8), l.id]));
    const byEmail = new Map(existing.filter((l) => l.email).map((l) => [l.email.toLowerCase(), l.id]));

    const list = await prisma.leadList.create({
      data: { userId: req.userId, name: listName, description: `Busca de empresas${segment ? `: ${segment}` : ''}`, type: 'static' }
    });

    let created = 0;
    let reused = 0;
    for (const p of prepared) {
      let leadId = (p.phone && byPhone.get(p.phone.replace(/\D/g, '').slice(-8))) || (p.email && byEmail.get(p.email));
      if (leadId) {
        reused += 1;
      } else {
        const lead = await prisma.lead.create({
          data: {
            userId: req.userId,
            name: p.name,
            phone: p.phone,
            email: p.email,
            address: p.address,
            tags,
            consentSource: 'busca_empresas_b2b',
            status: 'novo',
            source: 'prospeccao_b2b',
            sourceDetail: clip(`${segment || 'busca'} — ${clip(req.body?.location, 80)}`, 200)
          }
        });
        leadId = lead.id;
        created += 1;
        if (p.phone) byPhone.set(p.phone.replace(/\D/g, '').slice(-8), leadId);
        if (p.email) byEmail.set(p.email, leadId);
      }
      await prisma.leadListMembership.create({ data: { listId: list.id, leadId } });
    }

    res.status(201).json({ list: { id: list.id, name: list.name }, created, reused, skipped: items.length - prepared.length });
  } catch (error) {
    next(error);
  }
};

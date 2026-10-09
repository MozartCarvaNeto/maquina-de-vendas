// backend/src/controllers/leadsController.js
const prisma = require('../config/db');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const { processQualification } = require('../services/leadPipelineService');

exports.list = async (req, res, next) => {
  try {
    const { status, campaignId, search, preferredChannel, page = 1, pageSize = 20 } = req.query;

    const where = {
      userId: req.userId,
      ...(status ? { status } : {}),
      ...(campaignId ? { campaignId } : {}),
      ...(preferredChannel ? { preferredChannel } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search } },
              { email: { contains: search, mode: 'insensitive' } }
            ]
          }
        : {})
    };

    const take = Math.min(Number(pageSize) || 20, 200);
    const skip = (Number(page) - 1) * take;

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: { campaign: { select: { id: true, name: true } } }
      }),
      prisma.lead.count({ where })
    ]);

    res.json({ leads, total, page: Number(page), pageSize: take, totalPages: Math.ceil(total / take) || 1 });
  } catch (error) {
    next(error);
  }
};

exports.getById = async (req, res, next) => {
  try {
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, userId: req.userId },
      include: {
        campaign: true,
        crmCard: { include: { column: true } },
        calls: { orderBy: { createdAt: 'desc' } },
        messages: { orderBy: { createdAt: 'asc' } },
        listMemberships: { include: { list: { select: { id: true, name: true } } } }
      }
    });
    if (!lead) {
      return res.status(404).json({ error: 'Lead não encontrado' });
    }
    res.json({ lead });
  } catch (error) {
    next(error);
  }
};

exports.create = async (req, res, next) => {
  try {
    const { name, phone, email, address, tags, campaignId, consentSource, lastPurchaseAt, preferredChannel } =
      req.body;

    if (!name) {
      return res.status(400).json({ error: 'Nome é obrigatório' });
    }
    if (!phone && !email) {
      return res.status(400).json({ error: 'Informe pelo menos um contato: telefone ou e-mail' });
    }
    if (!consentSource) {
      return res.status(400).json({
        error: 'consentSource é obrigatório (de onde veio o consentimento deste lead)'
      });
    }
    if (preferredChannel && !['whatsapp', 'call', 'email'].includes(preferredChannel)) {
      return res.status(400).json({ error: 'preferredChannel deve ser "whatsapp", "call" ou "email"' });
    }
    if (preferredChannel === 'call' && !phone) {
      return res.status(400).json({ error: 'Não é possível definir canal "Ligação" para um lead sem telefone' });
    }
    if (preferredChannel === 'whatsapp' && !phone) {
      return res.status(400).json({ error: 'Não é possível definir canal "WhatsApp" para um lead sem telefone' });
    }
    if (preferredChannel === 'email' && !email) {
      return res.status(400).json({ error: 'Não é possível definir canal "E-mail" para um lead sem e-mail' });
    }

    const lead = await prisma.lead.create({
      data: {
        userId: req.userId,
        name,
        phone: phone || null,
        email: email || null,
        address: address || null,
        tags: Array.isArray(tags) ? tags : [],
        campaignId: campaignId || null,
        consentSource,
        lastPurchaseAt: lastPurchaseAt ? new Date(lastPurchaseAt) : null,
        preferredChannel: preferredChannel || null,
        status: 'novo'
      }
    });

    res.status(201).json({ lead });
  } catch (error) {
    next(error);
  }
};

exports.importCsv = async (req, res, next) => {
  try {
    const { campaignId, consentSource, listId, tags: globalTagsRaw } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo CSV enviado' });
    }
    if (!consentSource) {
      return res.status(400).json({
        error: 'consentSource é obrigatório para toda importação (base de onde veio a lista)'
      });
    }

    let targetList = null;
    if (listId) {
      targetList = await prisma.leadList.findFirst({ where: { id: listId, userId: req.userId } });
      if (!targetList) {
        return res.status(404).json({ error: 'Lista de leads informada não foi encontrada' });
      }
      if (targetList.type !== 'static') {
        return res.status(400).json({
          error: 'Só é possível adicionar leads importados a uma lista do tipo "estática"'
        });
      }
    }

    const globalTags = globalTagsRaw
      ? String(globalTagsRaw).split(',').map((t) => t.trim()).filter(Boolean)
      : [];

    // ------------------------------------------------------------------
    // Reconhecimento robusto de colunas (nome, telefone, e-mail, etc.)
    // ------------------------------------------------------------------
    // Cada planilha/CSV usa um nome de coluna diferente: "Nome completo",
    // "Nome do Cliente", "Telefone de Contato", "WhatsApp", "E-mail"...
    // Em vez de exigir um nome de coluna EXATO (o que fazia praticamente
    // todo arquivo real cair em "Linha sem nome"), normalizamos cada
    // cabeçalho (removendo acentos, espaços, maiúsculas) e comparamos com
    // uma lista de sinônimos conhecidos para cada campo. A ordem da lista
    // de campos e a ordem dos sinônimos dentro de cada campo importam: o
    // primeiro campo/sinônimo que bater define para que serve a coluna.
    function normalizeHeaderKey(value) {
      return String(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // remove acentos (ã, é, ç...)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, ''); // remove espaços, hífens, pontuação
    }

    const FIELD_SYNONYMS = [
      ['name', ['nomecompleto', 'nomedocliente', 'razaosocial', 'nomefantasia', 'nome', 'fullname', 'name']],
      ['phone', ['telefonedecontato', 'whatsapp', 'celular', 'telefone', 'numerodetelefone', 'numero', 'fone', 'phone', 'mobile', 'contato']],
      ['email', ['enderecodeemail', 'emailaddress', 'email']],
      ['address', ['enderecocompleto', 'endereco', 'address']],
      ['tags', ['etiquetas', 'tags']],
      ['lastPurchaseAt', ['ultimacompra', 'lastpurchaseat', 'lastpurchase']]
    ];

    // Compara PALAVRA POR PALAVRA (separadas por espaço), não um "contém em
    // qualquer lugar da string". Isso é importante: um cabeçalho como
    // "Telefone de Contato" deve bater com "telefone" — mas o nome de um
    // contato real (linha de dados, sem cabeçalho) não pode ser confundido
    // com um cabeçalho só porque contém, por acaso, uma palavra parecida
    // (ex: "Cliente Alessandra" não é um cabeçalho, é um nome de pessoa).
    function detectFieldForHeader(header) {
      const words = String(header)
        .split(/\s+/)
        .map(normalizeHeaderKey)
        .filter(Boolean);
      if (words.length === 0) return null;
      for (const [field, synonyms] of FIELD_SYNONYMS) {
        if (words.some((w) => synonyms.includes(w))) return field;
      }
      return null;
    }

    // Excel costuma converter números de telefone longos em número
    // (perdendo o zero à esquerda ou virando notação científica). Aqui
    // corrigimos os casos mais comuns antes de salvar.
    function sanitizePhoneValue(value) {
      const str = String(value).trim();
      if (/^\d+\.0$/.test(str)) return str.slice(0, -2);
      if (/e\+?\d+$/i.test(str)) {
        const num = Number(str);
        if (Number.isFinite(num)) return String(Math.round(num));
      }
      return str;
    }

    const PHONE_REGEX = /^\+?[\d()\s.-]{8,}$/;

    // Aceita tanto CSV quanto Excel (.xlsx/.xls) — detectado pelo nome do
    // arquivo e pelo mimetype, e convertido para o mesmo formato interno
    // (array de arrays) para que o resto da lógica seja idêntico.
    const originalName = (req.file.originalname || '').toLowerCase();
    const isExcel =
      originalName.endsWith('.xlsx') ||
      originalName.endsWith('.xls') ||
      req.file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      req.file.mimetype === 'application/vnd.ms-excel';

    let rawRows;
    if (isExcel) {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      rawRows = XLSX.utils
        .sheet_to_json(firstSheet, { header: 1, defval: '', raw: false })
        .map((row) => row.map((cell) => String(cell).trim()))
        .filter((row) => row.some((cell) => cell !== ''));
    } else {
      rawRows = parse(req.file.buffer, {
        columns: false,
        skip_empty_lines: true,
        trim: true
      });
    }

    const firstRow = rawRows[0] || [];
    // A primeira linha "parece um cabeçalho" se pelo menos uma célula bate
    // com algum sinônimo conhecido (nome, telefone, e-mail...). Isso cobre
    // tanto CSVs com cabeçalho de verdade (qualquer variação de rótulo)
    // quanto o caso headerless abaixo.
    const looksLikeHeader = firstRow.some((cell) => detectFieldForHeader(cell) !== null);

    // Algumas planilhas exportam o cabeçalho duplicado na segunda linha
    // (bug do sistema de origem). Detectamos e ignoramos essas linhas para
    // não tentar importar "Nome completo" como se fosse um contato real.
    function rowRepeatsHeader(row, header) {
      if (!row.length) return false;
      return row.every(
        (cell, i) => String(cell).trim().toLowerCase() === String(header[i] || '').trim().toLowerCase()
      );
    }

    let records;
    if (looksLikeHeader) {
      const fieldForColumnIndex = firstRow.map((h) => detectFieldForHeader(h));
      const dataRows = rawRows.slice(1).filter((row) => !rowRepeatsHeader(row, firstRow));
      records = dataRows.map((row) => {
        const record = {};
        fieldForColumnIndex.forEach((field, i) => {
          if (!field) return;
          if (record[field]) return; // primeira coluna que reconhecer o campo vence
          const value = row[i] !== undefined ? String(row[i]).trim() : '';
          if (value) record[field] = value;
        });
        return record;
      });
    } else {
      // Formato headerless (ex: export de contatos do telefone): cada linha
      // já é um contato. Coluna 0 = nome; a primeira coluna com "cara" de
      // telefone entre as demais é usada como telefone.
      records = rawRows.map((row) => {
        const name = row[0] || '';
        const phone = row.slice(1).find((cell) => PHONE_REGEX.test(String(cell).trim())) || '';
        return { name, phone };
      });
    }

    let imported = 0;
    let skipped = 0;
    const skippedReasons = [];

    for (const record of records) {
      const name = record.name || null;
      const phone = record.phone ? sanitizePhoneValue(record.phone) : null;
      const email = record.email || null;
      const address = record.address || null;
      const rowTagsRaw = record.tags || '';
      const rowTags = String(rowTagsRaw).split(';').map((t) => t.trim()).filter(Boolean);
      const lastPurchaseRaw = record.lastPurchaseAt || null;

      if (!name) {
        skipped += 1;
        skippedReasons.push('Linha sem nome');
        continue;
      }
      if (!phone && !email) {
        skipped += 1;
        skippedReasons.push(`Linha "${name}" sem telefone e sem e-mail`);
        continue;
      }

      const createdLead = await prisma.lead.create({
        data: {
          userId: req.userId,
          name,
          phone,
          email,
          address,
          tags: [...new Set([...globalTags, ...rowTags])],
          campaignId: campaignId || null,
          consentSource,
          lastPurchaseAt: lastPurchaseRaw ? new Date(lastPurchaseRaw) : null,
          status: 'novo'
        }
      });

      if (targetList) {
        await prisma.leadListMembership.create({
          data: { listId: targetList.id, leadId: createdLead.id }
        });
      }

      imported += 1;
    }

    res.json({ imported, skipped, total: records.length, skippedReasons: skippedReasons.slice(0, 20) });
  } catch (error) {
    next(error);
  }
};

exports.qualify = async (req, res, next) => {
  try {
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    if (!lead) {
      return res.status(404).json({ error: 'Lead não encontrado' });
    }

    const { answers } = req.body;
    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ error: 'Campo "answers" é obrigatório' });
    }

    const result = await processQualification({ leadId: lead.id, answers });

    res.json(result);
  } catch (error) {
    next(error);
  }
};

exports.update = async (req, res, next) => {
  try {
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    if (!lead) {
      return res.status(404).json({ error: 'Lead não encontrado' });
    }

    const { name, phone, email, address, tags, status, lastPurchaseAt, preferredChannel } = req.body;

    const finalPhone = phone !== undefined ? phone : lead.phone;
    const finalEmail = email !== undefined ? email : lead.email;

    if (!finalPhone && !finalEmail) {
      return res.status(400).json({ error: 'O lead precisa manter pelo menos telefone ou e-mail' });
    }

    if (preferredChannel !== undefined && preferredChannel !== null) {
      if (!['whatsapp', 'call', 'email'].includes(preferredChannel)) {
        return res.status(400).json({ error: 'preferredChannel deve ser "whatsapp", "call" ou "email"' });
      }
      if ((preferredChannel === 'call' || preferredChannel === 'whatsapp') && !finalPhone) {
        return res.status(400).json({ error: `Não é possível definir canal "${preferredChannel}" sem telefone` });
      }
      if (preferredChannel === 'email' && !finalEmail) {
        return res.status(400).json({ error: 'Não é possível definir canal "email" sem e-mail' });
      }
    }

    const updated = await prisma.lead.update({
      where: { id: lead.id },
      data: {
        ...(name ? { name } : {}),
        ...(phone !== undefined ? { phone } : {}),
        ...(email !== undefined ? { email } : {}),
        ...(address !== undefined ? { address } : {}),
        ...(tags !== undefined ? { tags: Array.isArray(tags) ? tags : [] } : {}),
        ...(status ? { status } : {}),
        ...(lastPurchaseAt !== undefined
          ? { lastPurchaseAt: lastPurchaseAt ? new Date(lastPurchaseAt) : null }
          : {}),
        ...(preferredChannel !== undefined ? { preferredChannel } : {})
      }
    });

    res.json({ lead: updated });
  } catch (error) {
    next(error);
  }
};

exports.optOut = async (req, res, next) => {
  try {
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    if (!lead) {
      return res.status(404).json({ error: 'Lead não encontrado' });
    }

    await prisma.lead.update({ where: { id: lead.id }, data: { optOut: true } });

    await prisma.callQueueItem.updateMany({
      where: { leadId: lead.id, status: 'pendente' },
      data: { status: 'pulado' }
    });

    res.json({ success: true, message: 'Lead marcado como opt-out e removido da fila' });
  } catch (error) {
    next(error);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    if (!lead) {
      return res.status(404).json({ error: 'Lead não encontrado' });
    }
    await prisma.lead.delete({ where: { id: lead.id } });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

// ==================== AÇÕES EM MASSA (REMANEJAMENTO) ====================

exports.bulkAssignCampaign = async (req, res, next) => {
  try {
    const { leadIds, campaignId } = req.body;

    if (!Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ error: 'leadIds deve ser um array não vazio' });
    }

    if (campaignId) {
      const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, userId: req.userId } });
      if (!campaign) {
        return res.status(404).json({ error: 'Campanha não encontrada' });
      }
    }

    const result = await prisma.lead.updateMany({
      where: { id: { in: leadIds }, userId: req.userId },
      data: { campaignId: campaignId || null }
    });

    res.json({ success: true, updated: result.count });
  } catch (error) {
    next(error);
  }
};

exports.bulkSetPreferredChannel = async (req, res, next) => {
  try {
    const { leadIds, preferredChannel } = req.body;

    if (!Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ error: 'leadIds deve ser um array não vazio' });
    }
    if (preferredChannel !== null && !['whatsapp', 'call', 'email'].includes(preferredChannel)) {
      return res.status(400).json({ error: 'preferredChannel deve ser "whatsapp", "call", "email" ou null' });
    }

    const leads = await prisma.lead.findMany({
      where: { id: { in: leadIds }, userId: req.userId }
    });

    let updated = 0;
    let skipped = 0;
    const skippedReasons = [];

    for (const lead of leads) {
      if (preferredChannel === 'call' && !lead.phone) {
        skipped += 1;
        skippedReasons.push(`${lead.name}: sem telefone, não pode ir para canal "Ligação"`);
        continue;
      }
      if (preferredChannel === 'whatsapp' && !lead.phone) {
        skipped += 1;
        skippedReasons.push(`${lead.name}: sem telefone, não pode ir para canal "WhatsApp"`);
        continue;
      }
      if (preferredChannel === 'email' && !lead.email) {
        skipped += 1;
        skippedReasons.push(`${lead.name}: sem e-mail, não pode ir para canal "E-mail"`);
        continue;
      }

      await prisma.lead.update({ where: { id: lead.id }, data: { preferredChannel } });
      updated += 1;
    }

    res.json({ success: true, updated, skipped, skippedReasons: skippedReasons.slice(0, 20) });
  } catch (error) {
    next(error);
  }
};

exports.bulkEnqueueCalls = async (req, res, next) => {
  try {
    const { leadIds } = req.body;

    if (!Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ error: 'leadIds deve ser um array não vazio' });
    }

    const leads = await prisma.lead.findMany({
      where: { id: { in: leadIds }, userId: req.userId }
    });

    let enqueued = 0;
    let skipped = 0;
    const skippedReasons = [];

    for (const lead of leads) {
      if (lead.optOut) {
        skipped += 1;
        skippedReasons.push(`${lead.name}: solicitou opt-out`);
        continue;
      }
      if (!lead.phone) {
        skipped += 1;
        skippedReasons.push(`${lead.name}: sem telefone cadastrado`);
        continue;
      }
      if (lead.preferredChannel && lead.preferredChannel !== 'call') {
        skipped += 1;
        skippedReasons.push(`${lead.name}: canal preferido é "${lead.preferredChannel}", não "Ligação"`);
        continue;
      }

      const existing = await prisma.callQueueItem.findFirst({
        where: { leadId: lead.id, status: { in: ['pendente', 'discando'] } }
      });
      if (existing) {
        skipped += 1;
        skippedReasons.push(`${lead.name}: já está na fila`);
        continue;
      }

      await prisma.callQueueItem.create({
        data: { userId: req.userId, leadId: lead.id, status: 'pendente' }
      });
      enqueued += 1;
    }

    res.json({ success: true, enqueued, skipped, skippedReasons: skippedReasons.slice(0, 20) });
  } catch (error) {
    next(error);
  }
};

/**
 * Adiciona manualmente um lote de leads ao CRM (quadro/coluna padrão,
 * geralmente "Novos"), sem depender de qualificação automática.
 * Ideal para leads importados via CSV sem campanha vinculada.
 */
exports.bulkAddToCrm = async (req, res, next) => {
  try {
    const { leadIds } = req.body;

    if (!Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ error: 'leadIds deve ser um array não vazio' });
    }

    let board = await prisma.crmBoard.findFirst({
      where: { userId: req.userId },
      include: { columns: { orderBy: { position: 'asc' } } }
    });

    if (!board) {
      board = await prisma.crmBoard.create({
        data: {
          userId: req.userId,
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
        },
        include: { columns: { orderBy: { position: 'asc' } } }
      });
    }

    const targetColumn = board.columns.find((c) => c.name === 'Novos') || board.columns[0];

    const leads = await prisma.lead.findMany({ where: { id: { in: leadIds }, userId: req.userId } });

    let added = 0;
    let skipped = 0;

    for (const lead of leads) {
      const existingCard = await prisma.crmCard.findUnique({ where: { leadId: lead.id } });
      if (existingCard) {
        skipped += 1;
        continue;
      }

      const cardCount = await prisma.crmCard.count({ where: { columnId: targetColumn.id } });
      await prisma.crmCard.create({
        data: { leadId: lead.id, columnId: targetColumn.id, position: cardCount }
      });
      added += 1;
    }

    res.json({ success: true, added, skipped, boardId: board.id, columnName: targetColumn.name });
  } catch (error) {
    next(error);
  }
};
// backend/src/controllers/emailDomainController.js
const emailDomainService = require('../services/email/emailDomainService');

exports.list = async (req, res, next) => {
  try {
    const domains = await emailDomainService.listDomains(req.userId);
    // nunca devolve a chave privada para o frontend
    res.json({ domains: domains.map(({ dkimPrivateKeyEnc, ...rest }) => rest) });
  } catch (error) {
    next(error);
  }
};

exports.create = async (req, res, next) => {
  try {
    const { domain, fromEmail, fromName } = req.body;
    if (!domain) return res.status(400).json({ error: 'Informe o domínio, ex: suaempresa.com.br' });

    const created = await emailDomainService.createOrUpdateDomain(req.userId, domain, { fromEmail, fromName });
    const { dkimPrivateKeyEnc, ...safe } = created;
    res.status(201).json({ domain: safe });
  } catch (error) {
    next(error);
  }
};

exports.updateIdentity = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromEmail, fromName } = req.body;
    const updated = await emailDomainService.updateIdentity(req.userId, id, { fromEmail, fromName });
    const { dkimPrivateKeyEnc, ...safe } = updated;
    res.json({ domain: safe });
  } catch (error) {
    next(error);
  }
};

exports.setDefault = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updated = await emailDomainService.setDefaultDomain(req.userId, id);
    const { dkimPrivateKeyEnc, ...safe } = updated;
    res.json({ domain: safe });
  } catch (error) {
    next(error);
  }
};

exports.getDnsInstructions = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { domain, publicIp, records } = await emailDomainService.getDnsSetupInstructions(req.userId, id);
    const { dkimPrivateKeyEnc, ...safeDomain } = domain;
    res.json({ domain: safeDomain, publicIp, records });
  } catch (error) {
    next(error);
  }
};

exports.verify = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updated = await emailDomainService.verifyDomain(req.userId, id);
    const { dkimPrivateKeyEnc, ...safe } = updated;
    res.json({ domain: safe });
  } catch (error) {
    next(error);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const { id } = req.params;
    await emailDomainService.deleteDomain(req.userId, id);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};
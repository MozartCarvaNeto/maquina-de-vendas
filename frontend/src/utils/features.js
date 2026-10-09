// frontend/src/utils/features.js
//
// Quais MÓDULOS o plano do cliente libera. O servidor é quem realmente bloqueia;
// aqui só escondemos/cadeamos o que não está no plano para não confundir.
// `user.features` = null (ou ausente) significa "todos os módulos".

export function getStoredUser() {
  try {
    return JSON.parse(localStorage.getItem('mdv_user') || '{}');
  } catch {
    return {};
  }
}

/** Basta UM dos módulos informados estar liberado. */
export function userHasFeature(user, ...keys) {
  if (!user || user.isPlatformAdmin) return true;
  if (!Array.isArray(user.features)) return true;
  return keys.flat().some((key) => user.features.includes(key));
}

export const FEATURE_NAMES = {
  contatos: 'Contatos, Listas e Campanhas',
  conexoes: 'Conexões de WhatsApp',
  chat: 'Chat',
  crm: 'CRM',
  disparos: 'Disparos em massa',
  discador: 'Discador para equipes de vendas',
  robo: 'Robô de ligações',
  agente_ia: 'Agente de IA por voz'
};

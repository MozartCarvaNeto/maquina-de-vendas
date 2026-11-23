// Lista das páginas que podem ter vídeo tutorial. "key" = primeiro trecho do endereço (dashboard = "/").
export const TUTORIAL_PAGES = [
  { key: 'dashboard', label: '📊 Dashboard' },
  { key: 'chat', label: '💬 Chat' },
  { key: 'telefone', label: '☎️ Telefone WhatsApp' },
  { key: 'crm', label: '📋 CRM' },
  { key: 'campanhas', label: '🎯 Campanhas' },
  { key: 'buscar-empresas', label: '🔍 Buscar Empresas' },
  { key: 'listas', label: '🗂️ Listas' },
  { key: 'disparos', label: '📣 Disparos' },
  { key: 'telefone-sip', label: '📞 Telefone (ligações)' },
  { key: 'pbx', label: '🏢 Telefonia PBX (URA e filas)' },
  { key: 'gateway', label: '📡 Gateway de telecom' },
  { key: 'conexoes', label: '📱 Conexões' },
  { key: 'discador', label: '📞 Discador' },
  { key: 'ligacoes', label: '☎️ Ligações' },
  { key: 'linhas', label: '🔀 Linhas' },
  { key: 'equipe', label: '🧑‍🤝‍🧑 Equipe' },
  { key: 'contatos', label: '👥 Contatos' },
  { key: 'notas-fiscais', label: '🧾 Notas Fiscais' },
  { key: 'bloqueios', label: '🚫 Lista de bloqueio' },
  { key: 'indicacoes', label: '🤝 Indique e ganhe' },
  { key: 'revendedor', label: '🏪 Meus clientes (revenda)' },
  { key: 'marca', label: '🎨 Marca própria' },
  { key: 'configuracoes', label: '⚙️ Configurações' },
  { key: 'assinatura', label: '💳 Minha assinatura' }
];

export function pageKeyFromPath(pathname) {
  const seg = String(pathname || '/').split('/').filter(Boolean)[0] || 'dashboard';
  return seg === 'robo-ligacoes' ? 'ligacoes' : seg;
}
export const thumbUrl = (videoId) => `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

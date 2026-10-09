// frontend/src/components/crm/followUpUtils.js
// Funções compartilhadas do "retorno agendado" (cards, painel, modal).

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** 'overdue' (passou do horário) | 'today' (vence hoje) | 'scheduled' (futuro) | null */
export function getFollowUpState(followUpAt, now = new Date()) {
  if (!followUpAt) return null;
  const date = new Date(followUpAt);
  if (date.getTime() < now.getTime()) return 'overdue';
  if (startOfDay(date).getTime() === startOfDay(now).getTime()) return 'today';
  return 'scheduled';
}

const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });

export function formatFollowUpLabel(followUpAt, now = new Date()) {
  if (!followUpAt) return '';
  const date = new Date(followUpAt);
  const state = getFollowUpState(followUpAt, now);
  const time = timeFmt.format(date);

  if (state === 'overdue') {
    const days = Math.floor((startOfDay(now).getTime() - startOfDay(date).getTime()) / DAY);
    if (days <= 0) return `Atrasado — era hoje às ${time}`;
    return days === 1 ? `Atrasado — era ontem às ${time}` : `Atrasado há ${days} dias (${dateFmt.format(date)} ${time})`;
  }
  if (state === 'today') return `Retornar hoje às ${time}`;
  const diff = Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / DAY);
  if (diff === 1) return `Retornar amanhã às ${time}`;
  return `Retornar em ${dateFmt.format(date)} às ${time}`;
}

/** Valor para <input type="datetime-local"> (horário local). */
export function toInputValue(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Atalhos de data: hoje+N dias às `hour`h. */
export function inDaysAt(days, hour = 9) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return toInputValue(d);
}

export function isLostColumn(column) {
  return /perdid/i.test(column?.name || '');
}

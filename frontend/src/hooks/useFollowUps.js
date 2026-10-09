// frontend/src/hooks/useFollowUps.js
//
// Aviso dos retornos de clientes (vencendo hoje / atrasados). Existe UM único
// "puxador" para o app inteiro (sidebar + tela inicial usam o mesmo): consulta
// um resumo bem pequeno a cada 60 s, só com a aba visível.
import { useEffect, useState } from 'react';
import api from '../services/api';

const POLL_MS = 60 * 1000;

let state = { loaded: false, counts: { overdue: 0, today: 0, upcoming: 0 }, due: [], upcoming: [] };
const listeners = new Set();
let timer = null;
let inFlight = false;
const notifiedCardIds = new Set();

function emit() {
  listeners.forEach((listener) => listener(state));
}

async function showBrowserNotification(title, body) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const registration = await navigator.serviceWorker?.getRegistration?.();
    if (registration?.showNotification) {
      registration.showNotification(title, { body, icon: '/pwa-192.png', tag: 'mdv-followup' });
    } else {
      new Notification(title, { body, icon: '/pwa-192.png' });
    }
  } catch {
    // notificação não suportada neste navegador: o aviso na tela continua funcionando
  }
}

function notifyNewOverdue(due) {
  const fresh = due.filter((item) => item.state === 'overdue' && !notifiedCardIds.has(item.cardId));
  if (fresh.length === 0) return;
  fresh.forEach((item) => notifiedCardIds.add(item.cardId));
  const first = fresh[0];
  const body =
    fresh.length === 1
      ? `${first.leadName} está esperando o seu retorno.`
      : `${first.leadName} e mais ${fresh.length - 1} cliente(s) estão esperando o seu retorno.`;
  showBrowserNotification('🔔 Retorno de cliente vencido', body);
}

export async function refreshFollowUps() {
  if (inFlight || !localStorage.getItem('mdv_token')) return;
  // Plano sem CRM: não consulta retornos (evita erro 403 a cada ciclo).
  try {
    const u = JSON.parse(localStorage.getItem('mdv_user') || '{}');
    if (!u.isPlatformAdmin && Array.isArray(u.features) && !u.features.includes('crm')) return;
  } catch {
    /* usuário ilegível: segue o fluxo normal */
  }
  inFlight = true;
  try {
    const { data } = await api.get('/crm/followups/summary');
    state = { loaded: true, counts: data.counts, due: data.due, upcoming: data.upcoming };
    emit();
    notifyNewOverdue(data.due);
  } catch {
    // sem rede / sessão expirada: tenta de novo no próximo ciclo
  } finally {
    inFlight = false;
  }
}

function onVisible() {
  if (!document.hidden) refreshFollowUps();
}

function start() {
  if (timer) return;
  refreshFollowUps();
  timer = setInterval(() => {
    if (!document.hidden) refreshFollowUps();
  }, POLL_MS);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
}

function stop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  document.removeEventListener('visibilitychange', onVisible);
  window.removeEventListener('focus', onVisible);
}

export async function requestFollowUpNotifications() {
  if (typeof Notification === 'undefined') return 'unsupported';
  const result = await Notification.requestPermission();
  if (result === 'granted') {
    showBrowserNotification('🔔 Avisos ativados', 'Você será avisado quando um retorno de cliente vencer.');
  }
  return result;
}

export function useFollowUps() {
  const [value, setValue] = useState(state);

  useEffect(() => {
    listeners.add(setValue);
    setValue(state);
    start();
    return () => {
      listeners.delete(setValue);
      if (listeners.size === 0) stop();
    };
  }, []);

  return value;
}

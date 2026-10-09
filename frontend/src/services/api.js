// frontend/src/services/api.js
import axios from 'axios';

const api = axios.create({
  // Em produção (npm run build) o backend serve o site, então a API está no mesmo endereço.
  baseURL: import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '/api' : 'http://localhost:3333/api')
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('mdv_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Códigos que o servidor devolve quando a conta não pode usar o sistema
// (cadastro pendente, bloqueio manual ou assinatura vencida).
const ACCESS_CODES = ['ACCESS_PENDING', 'ACCESS_BLOCKED', 'SUBSCRIPTION_EXPIRED'];

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    // Nas telas de login/cadastro quem mostra o erro é a própria tela (sem redirecionar).
    const isAuthCall = /\/auth\/(login|register)/.test(error.config?.url || '');

    if (status === 401 && !isAuthCall) {
      localStorage.removeItem('mdv_restricted');
      localStorage.removeItem('mdv_token');
      localStorage.removeItem('mdv_user');
      window.location.href = '/login';
    }

    // Assinatura venceu / conta bloqueada no meio do uso: sai e explica o motivo.
    if (status === 403 && ACCESS_CODES.includes(error.response?.data?.code) && !isAuthCall) {
      sessionStorage.setItem('mdv_access_msg', error.response.data.error || 'O acesso desta conta está suspenso.');
      localStorage.removeItem('mdv_restricted');
      localStorage.removeItem('mdv_token');
      localStorage.removeItem('mdv_user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;
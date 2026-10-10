// frontend/src/hooks/usePublicConfig.js
//
// Configurações públicas do servidor (modo de cadastro, contato de suporte...).
// Buscadas uma única vez e guardadas em memória.
import { useEffect, useState } from 'react';
import api from '../services/api';

const DEFAULTS = { appName: 'Turbo Prospect', registrationMode: 'approval', supportContact: null, billingEnabled: false };
let cache = null;

export default function usePublicConfig() {
  const [config, setConfig] = useState(cache || DEFAULTS);

  useEffect(() => {
    if (cache) return;
    api
      .get('/public/config')
      .then(({ data }) => {
        cache = { ...DEFAULTS, ...data };
        setConfig(cache);
      })
      .catch(() => {});
  }, []);

  return config;
}

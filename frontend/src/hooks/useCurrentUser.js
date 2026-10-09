// frontend/src/hooks/useCurrentUser.js
//
// Usuário salvo no navegador, atualizado na hora quando o sistema renova os
// dados dele (evento "mdv:user-updated", disparado pelo SubscriptionBanner).
import { useEffect, useState } from 'react';
import { getStoredUser } from '../utils/features';

export const USER_UPDATED_EVENT = 'mdv:user-updated';

export default function useCurrentUser() {
  const [user, setUser] = useState(getStoredUser);

  useEffect(() => {
    const refresh = () => setUser(getStoredUser());
    window.addEventListener(USER_UPDATED_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(USER_UPDATED_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  return user;
}

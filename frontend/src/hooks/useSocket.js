// frontend/src/hooks/useSocket.js
import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

export function useSocket(userId) {
  const socketRef = useRef(null);
  const [socket, setSocket] = useState(null);

  useEffect(() => {
    if (!userId) return undefined;

    const instance = io(import.meta.env.VITE_SOCKET_URL || (import.meta.env.PROD ? window.location.origin : 'http://localhost:3333'), {
      // O servidor agora exige o token de login para abrir o socket.
      auth: { token: localStorage.getItem('mdv_token') },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 10
    });

    socketRef.current = instance;

    const handleConnect = () => {
      console.log('🔌 Socket conectado, entrando na sala user:' + userId);
      instance.emit('join-user', userId);
    };

    instance.on('connect', handleConnect);

    // Se já estiver conectado no momento do registro, entra na sala imediatamente.
    if (instance.connected) {
      handleConnect();
    }

    setSocket(instance);

    return () => {
      instance.off('connect', handleConnect);
      instance.disconnect();
      socketRef.current = null;
      setSocket(null);
    };
  }, [userId]);

  return { socket, socketRef };
}
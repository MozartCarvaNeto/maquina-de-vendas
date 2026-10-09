// frontend/src/pwa/PwaManager.jsx
//
// Dois avisos discretos, sempre visíveis em qualquer página:
//  1) "Instalar aplicativo" — aparece quando o navegador permite instalar
//     (Chrome/Edge no desktop e Android; no iPhone o Safari não dá esse
//     aviso, por isso o texto abaixo também explica o caminho manual).
//  2) "Nova versão disponível" — aparece quando você publica uma atualização
//     e a pessoa já está com o app aberto.
import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import './PwaManager.css';

function isRunningStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

export default function PwaManager() {
  const [installEvent, setInstallEvent] = useState(null);
  const [installed, setInstalled] = useState(isRunningStandalone());
  const [showIosHint, setShowIosHint] = useState(false);

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker
  } = useRegisterSW({
    onRegisteredSW(url, registration) {
      // Confere se já tem uma versão nova esperando a cada 60 minutos —
      // cobre quem deixa a aba aberta o dia inteiro.
      if (!registration) return;
      setInterval(() => registration.update(), 60 * 60 * 1000);
    }
  });

  useEffect(() => {
    function onBeforeInstallPrompt(event) {
      event.preventDefault();
      setInstallEvent(event);
    }
    function onInstalled() {
      setInstalled(true);
      setInstallEvent(null);
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  async function handleInstallClick() {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice;
    setInstallEvent(null);
  }

  const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
  const canShowInstallButton = !installed && !!installEvent;
  const canShowIosButton = !installed && isIos && !installEvent;

  return (
    <>
      {needRefresh && (
        <div className="pwa-toast">
          <span>🔄 Nova versão disponível.</span>
          <button onClick={() => updateServiceWorker(true)}>Atualizar agora</button>
          <button className="pwa-toast-dismiss" onClick={() => setNeedRefresh(false)}>Depois</button>
        </div>
      )}

      {canShowInstallButton && (
        <button className="pwa-install-fab" onClick={handleInstallClick}>
          📲 Instalar aplicativo
        </button>
      )}

      {canShowIosButton && (
        <button className="pwa-install-fab" onClick={() => setShowIosHint(true)}>
          📲 Instalar aplicativo
        </button>
      )}

      {showIosHint && (
        <div className="pwa-ios-hint" onClick={() => setShowIosHint(false)}>
          <div className="pwa-ios-hint-box" onClick={(e) => e.stopPropagation()}>
            <p>No iPhone/iPad, a instalação é feita direto pelo Safari:</p>
            <ol>
              <li>Toque no ícone de compartilhar (o quadrado com a seta ↑)</li>
              <li>Escolha "Adicionar à Tela de Início"</li>
            </ol>
            <button onClick={() => setShowIosHint(false)}>Entendi</button>
          </div>
        </div>
      )}
    </>
  );
}

// frontend/src/pages/Ligacoes.jsx
//
// Ponto de entrada único para ligações: o usuário escolhe entre o robô
// (o sistema liga sozinho e toca um áudio), o modo vendedor humano (a pessoa
// liga com o próprio telefone e o sistema só organiza a fila e anota o
// resultado) e o Agente IA (a IA conversa, qualifica e chama o vendedor).
import { useState } from 'react';
import RoboLigacoes from './RoboLigacoes';
import DiscagemManual from './DiscagemManual';
import AgenteIA from './AgenteIA';
import useCurrentUser from '../hooks/useCurrentUser';
import { userHasFeature } from '../utils/features';
import './Ligacoes.css';

export default function Ligacoes() {
  const user = useCurrentUser();
  // Cada aba é um módulo diferente do plano.
  const allowed = {
    robo: userHasFeature(user, 'robo'),
    manual: userHasFeature(user, 'discador'),
    ia: userHasFeature(user, 'agente_ia')
  };
  const [savedMode, setMode] = useState(() => localStorage.getItem('mdv_ligacoes_mode') || 'robo');
  // Se a aba salva não está no plano, abre a primeira que estiver.
  const mode = allowed[savedMode] ? savedMode : ['robo', 'manual', 'ia'].find((m) => allowed[m]) || savedMode;

  function selectMode(next) {
    if (!allowed[next]) return;
    setMode(next);
    localStorage.setItem('mdv_ligacoes_mode', next);
  }

  return (
    <div className="ligacoes-page">
      <div className="ligacoes-switch">
        <button className={mode === 'robo' ? 'active' : ''} onClick={() => selectMode('robo')} disabled={!allowed.robo} title={allowed.robo ? undefined : 'Não incluído no seu plano'}>
          🤖 Automático{!allowed.robo && ' 🔒'}
          <small>O sistema liga sozinho, toca o áudio e qualifica</small>
        </button>
        <button className={mode === 'manual' ? 'active' : ''} onClick={() => selectMode('manual')} disabled={!allowed.manual} title={allowed.manual ? undefined : 'Não incluído no seu plano'}>
          🧑‍💼 Vendedor Humano{!allowed.manual && ' 🔒'}
          <small>Você liga com o seu telefone, o sistema organiza a fila</small>
        </button>
        <button className={mode === 'ia' ? 'active' : ''} onClick={() => selectMode('ia')} disabled={!allowed.ia} title={allowed.ia ? undefined : 'Não incluído no seu plano'}>
          🧠 Agente IA{!allowed.ia && ' 🔒'}
          <small>A IA conversa, qualifica e chama o vendedor quando a venda está pronta</small>
        </button>
      </div>

      {mode === 'robo' && <RoboLigacoes />}
      {mode === 'manual' && <DiscagemManual />}
      {mode === 'ia' && <AgenteIA />}
    </div>
  );
}

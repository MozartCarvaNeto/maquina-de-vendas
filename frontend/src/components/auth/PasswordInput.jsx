// frontend/src/components/auth/PasswordInput.jsx
//
// Campo de senha com botão "ver senha" (ajuda muito a digitar no celular).
import { useState } from 'react';

export default function PasswordInput({ value, onChange, autoComplete = 'current-password', ...rest }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="pw-field">
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        {...rest}
      />
      <button type="button" onClick={() => setVisible((v) => !v)} aria-label={visible ? 'Esconder senha' : 'Mostrar senha'} tabIndex={-1}>
        {visible ? '🙈' : '👁️'}
      </button>
    </div>
  );
}

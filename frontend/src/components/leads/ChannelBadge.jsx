// frontend/src/components/leads/ChannelBadge.jsx
import './ChannelBadge.css';

const CHANNEL_LABELS = {
  whatsapp: '💬 WhatsApp',
  call: '📞 Ligação',
  email: '📧 E-mail'
};

/**
 * Mostra o canal preferido do lead (se definido) e, sempre que faltar
 * telefone ou e-mail, um aviso claro sobre o que NÃO pode ser feito com
 * este contato — usado em Contatos, Discador e Chat.
 */
export default function ChannelBadge({ lead }) {
  return (
    <div className="channel-badge-wrapper">
      {lead.preferredChannel && (
        <span className="channel-badge">{CHANNEL_LABELS[lead.preferredChannel]}</span>
      )}
      {!lead.phone && (
        <span className="channel-warning" title="Este lead não tem telefone cadastrado">
          ⚠️ Sem telefone — não pode ligar, mandar WhatsApp ou SMS
        </span>
      )}
      {!lead.email && (
        <span className="channel-warning" title="Este lead não tem e-mail cadastrado">
          ⚠️ Sem e-mail — não recebe disparos por e-mail
        </span>
      )}
    </div>
  );
}
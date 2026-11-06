// backend/src/services/smsgw/asteriskConfig.js
// Gera os arquivos de configuração do Asterisk (PBX gratuito) a partir dos troncos SIP cadastrados.
// O Asterisk é quem fala SIP/RTP com o fornecedor de voz; o portal só descreve o que ele deve fazer.
const { decrypt } = require('../crypto/settingsCrypto');

function safeName(name, i) {
  const base = String(name || `tronco${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `tp_${base || `tronco${i + 1}`}`;
}

function transportName(t) {
  return `transport-${['udp', 'tcp', 'tls'].includes(t) ? t : 'udp'}`;
}

function buildAsteriskConfig(trunks) {
  const active = trunks.filter((t) => t.enabled);
  const names = active.map((t, i) => safeName(t.name, i));
  const lines = [];
  lines.push('; ============================================================================');
  lines.push('; Gerado pelo Turbo Prospect (Gateway de telecom). Não edite à mão: gere de novo.');
  lines.push('; Inclua no final do /etc/asterisk/pjsip.conf com a linha:  #include pjsip_turbo.conf');
  lines.push('; ============================================================================');
  lines.push('');
  lines.push('[transport-udp]\ntype=transport\nprotocol=udp\nbind=0.0.0.0:5060\n');
  lines.push('[transport-tcp]\ntype=transport\nprotocol=tcp\nbind=0.0.0.0:5060\n');
  if (active.some((t) => t.transport === 'tls')) {
    lines.push('; Para TLS configure cert_file/priv_key_file do seu domínio abaixo.');
    lines.push('[transport-tls]\ntype=transport\nprotocol=tls\nbind=0.0.0.0:5061\n; cert_file=/etc/asterisk/keys/asterisk.crt\n; priv_key_file=/etc/asterisk/keys/asterisk.key\nmethod=tlsv1_2\n');
  }
  active.forEach((t, i) => {
    const n = names[i];
    let password = '';
    try {
      password = t.passwordEnc ? decrypt(t.passwordEnc) : '';
    } catch (_) {
      password = '*** cadastre a senha do tronco de novo ***';
    }
    const uri = `sip:${t.host}:${t.port}${t.transport === 'tcp' ? ';transport=tcp' : t.transport === 'tls' ? ';transport=tls' : ''}`;
    lines.push(`; ---- Tronco: ${t.name} ----`);
    if (t.username) {
      lines.push(`[auth_${n}]\ntype=auth\nauth_type=userpass\nusername=${t.username}\npassword=${password}\n`);
    }
    if (t.register && t.username) {
      lines.push(`[reg_${n}]\ntype=registration\noutbound_auth=auth_${n}\nserver_uri=${uri}\nclient_uri=sip:${t.username}@${t.host}\nretry_interval=60\ntransport=${transportName(t.transport)}\n`);
    }
    lines.push(`[aor_${n}]\ntype=aor\ncontact=${uri}\n`);
    lines.push(
      `[${n}]\ntype=endpoint\ntransport=${transportName(t.transport)}\ncontext=turbo-from-trunk\ndisallow=all\nallow=${t.codecs || 'alaw,ulaw'}\n` +
        `aors=aor_${n}\n${t.username ? `outbound_auth=auth_${n}\n` : ''}${t.fromDomain ? `from_domain=${t.fromDomain}\n` : ''}` +
        `${t.outboundCallerId ? `from_user=${t.outboundCallerId}\n` : t.username ? `from_user=${t.username}\n` : ''}direct_media=no\nrtp_symmetric=yes\nforce_rport=yes\nrewrite_contact=yes\ndtmf_mode=rfc4733\n`
    );
    lines.push(`[identify_${n}]\ntype=identify\nendpoint=${n}\nmatch=${t.host}\n`);
  });

  const dial = [];
  dial.push('; Inclua no /etc/asterisk/extensions.conf:  #include extensions_turbo.conf');
  dial.push('[turbo-out]');
  dial.push('; Ligações de saída: o portal chama este contexto com o número já em formato internacional (ex.: 5511999998888).');
  if (active.length) {
    active.forEach((t, i) => {
      const prefix = t.dialPrefix || '';
      dial.push(`exten => _X.,${i === 0 ? '1' : 'n'},${i === 0 ? '' : 'GotoIf($["${DIALSTATUS}" = "ANSWER"]?done)\nsame => n,'}Dial(PJSIP/${prefix}\${EXTEN}@${names[i]},60)`);
    });
    dial.push('same => n(done),Hangup()');
  } else {
    dial.push('exten => _X.,1,Hangup()');
  }
  dial.push('');
  dial.push('[turbo-from-trunk]');
  dial.push('; Ligações recebidas dos fornecedores. Ajuste para o seu atendimento (ramal, fila ou IA).');
  dial.push('exten => _X.,1,NoOp(Chamada recebida de ${CALLERID(num)} para ${EXTEN})');
  dial.push('same => n,Answer()');
  dial.push('same => n,Playback(hello-world)');
  dial.push('same => n,Hangup()');
  return { pjsip: lines.join('\n'), extensions: dial.join('\n'), trunks: names };
}

module.exports = { buildAsteriskConfig };

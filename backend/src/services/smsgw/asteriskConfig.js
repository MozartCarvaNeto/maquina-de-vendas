// backend/src/services/smsgw/asteriskConfig.js
// Gera os arquivos de configuração do Asterisk (PBX gratuito) a partir dos troncos SIP (fornecedores de voz)
// e dos ramais da equipe (telefone no navegador via WebRTC). O Asterisk fala SIP/RTP com o fornecedor;
// o portal só descreve o que ele deve fazer.
const { decrypt } = require('../crypto/settingsCrypto');

function safeName(name, i) {
  const base = String(name || `tronco${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `tp_${base || `tronco${i + 1}`}`;
}

function transportName(t) {
  return `transport-${['udp', 'tcp', 'tls'].includes(t) ? t : 'udp'}`;
}

function plain(passwordEnc) {
  try {
    return passwordEnc ? decrypt(passwordEnc) : '';
  } catch (_) {
    return '*** cadastre a senha de novo ***';
  }
}

/**
 * @param {Array} trunks  troncos SIP (SipTrunk)
 * @param {Array} extensions  ramais [{extension, passwordEnc, name}]
 */
function buildAsteriskConfig(trunks, extensions = []) {
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
  lines.push('; WebSocket (telefone no navegador). O nginx cuida do https (wss) e repassa para cá.');
  lines.push('[transport-ws]\ntype=transport\nprotocol=ws\nbind=0.0.0.0\n');
  if (active.some((t) => t.transport === 'tls')) {
    lines.push('; Para TLS configure cert_file/priv_key_file do seu domínio abaixo.');
    lines.push('[transport-tls]\ntype=transport\nprotocol=tls\nbind=0.0.0.0:5061\n; cert_file=/etc/asterisk/keys/asterisk.crt\n; priv_key_file=/etc/asterisk/keys/asterisk.key\nmethod=tlsv1_2\n');
  }

  active.forEach((t, i) => {
    const n = names[i];
    const uri = `sip:${t.host}:${t.port}${t.transport === 'tcp' ? ';transport=tcp' : t.transport === 'tls' ? ';transport=tls' : ''}`;
    lines.push(`; ---- Tronco: ${t.name} ----`);
    if (t.username) {
      lines.push(`[auth_${n}]\ntype=auth\nauth_type=userpass\nusername=${t.username}\npassword=${plain(t.passwordEnc)}\n`);
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

  if (extensions.length) {
    lines.push('; ---- Ramais da equipe (telefone no navegador, WebRTC) ----');
    extensions.forEach((x) => {
      const id = x.extension;
      lines.push(
        `; ${x.name || id}\n[${id}]\ntype=aor\nmax_contacts=5\nremove_existing=yes\nqualify_frequency=30\n\n` +
          `[auth${id}]\ntype=auth\nauth_type=userpass\nusername=${id}\npassword=${plain(x.passwordEnc)}\n\n` +
          `[${id}]\ntype=endpoint\ntransport=transport-ws\ncontext=turbo-agent\ndisallow=all\nallow=opus,ulaw,alaw\nwebrtc=yes\n` +
          `auth=auth${id}\naors=${id}\ndtmf_mode=rfc4733\ndirect_media=no\nrtp_symmetric=yes\nforce_rport=yes\nrewrite_contact=yes\n` +
          `callerid="${String(x.name || id).replace(/"/g, '')}" <${id}>\n`
      );
    });
  }

  const dial = [];
  dial.push('; Inclua no /etc/asterisk/extensions.conf:  #include extensions_turbo.conf');
  const outLines = [];
  if (active.length) {
    active.forEach((t, i) => {
      const prefix = t.dialPrefix || '';
      if (i > 0) outLines.push('same => n,GotoIf($["${DIALSTATUS}" = "ANSWER"]?done)');
      outLines.push(`${i === 0 ? 'exten => _X.,1' : 'same => n'},Dial(PJSIP/${prefix}\${EXTEN}@${names[i]},60)`);
    });
    outLines.push('same => n(done),Hangup()');
  } else {
    outLines.push('exten => _X.,1,Hangup()');
  }
  dial.push('[turbo-out]');
  dial.push('; Ligações de saída: número em formato internacional (ex.: 5511999998888).');
  dial.push(...outLines);
  dial.push('');
  dial.push('[turbo-agent]');
  dial.push('; Quando um vendedor disca pelo navegador, cai aqui e sai pelo(s) tronco(s) acima (na ordem).');
  dial.push(...outLines);
  dial.push('');
  dial.push('[turbo-from-trunk]');
  dial.push('; Ligações recebidas: tocam em todos os ramais da equipe que estiverem com o telefone aberto.');
  dial.push('exten => _X.,1,NoOp(Chamada recebida de ${CALLERID(num)} para ${EXTEN})');
  if (extensions.length) {
    dial.push(`same => n,Dial(${extensions.map((x) => `PJSIP/${x.extension}`).join('&')},40)`);
  }
  dial.push('same => n,Playback(vm-nobodyavail)');
  dial.push('same => n,Hangup()');
  return { pjsip: lines.join('\n'), extensions: dial.join('\n'), trunks: names, extensionCount: extensions.length };
}

module.exports = { buildAsteriskConfig };

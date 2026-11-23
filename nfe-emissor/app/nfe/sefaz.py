"""Comunicação SOAP 1.2 com os web services da SEFAZ (NF-e 4.00, modelo 55)."""
import copy
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import requests
from lxml import etree

from .assinatura import assinar
from .certificado import Certificado
from . import tls
from .sefaz_urls import obter_url
from .xml_builder import NS, serializar

ACOES = {
    "NFeAutorizacao4": "nfeAutorizacaoLote",
    "NFeRetAutorizacao4": "nfeRetAutorizacaoLote",
    "NFeConsultaProtocolo4": "nfeConsultaNF",
    "NFeStatusServico4": "nfeStatusServicoNF",
    "NFeRecepcaoEvento4": "nfeRecepcaoEvento",
}


class SefazErro(Exception):
    """Falha de comunicação ou resposta inesperada."""


class SefazTimeout(SefazErro):
    """A SEFAZ pode ter processado a nota mesmo sem responder: CONSULTE antes de reenviar."""


@dataclass
class Contexto:
    autorizador: str
    ambiente: str
    pem: str                      # caminho do PEM temporário (certificado + chave)
    timeout: int = 60
    ca_bundle: str | None = None
    urls_override: dict | Path | None = None   # alterações feitas em Configurações
    data_dir: Path | None = None               # onde fica a cadeia ICP-Brasil baixada
    auto_cadeia: bool = True                   # baixa a cadeia sozinho se faltar


def _t(nome: str) -> str:
    return f"{{{NS}}}{nome}"


def _s(pai, nome: str, texto=None, **attrs):
    el = etree.SubElement(pai, _t(nome), **attrs)
    if texto is not None:
        el.text = str(texto)
    return el


def _filho(el, nome: str):
    return None if el is None else el.find(_t(nome))


def _txt(el, nome: str) -> str | None:
    f = _filho(el, nome)
    return f.text if f is not None else None


def para_texto(el) -> str:
    return etree.tostring(el, encoding="unicode")


# ----------------------------------------------------------------------------------------
# Transporte
# ----------------------------------------------------------------------------------------
def chamar(servico: str, xml_msg: str, ctx: Contexto):
    """Envia `xml_msg` ao serviço e devolve o elemento de resposta (ex.: retEnviNFe)."""
    url = obter_url(ctx.autorizador, ctx.ambiente, servico, ctx.urls_override)
    ns_wsdl = f"http://www.portalfiscal.inf.br/nfe/wsdl/{servico}"
    envelope = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">'
        f'<soap12:Body><nfeDadosMsg xmlns="{ns_wsdl}">{xml_msg}</nfeDadosMsg></soap12:Body>'
        '</soap12:Envelope>'
    )
    headers = {"Content-Type":
               f'application/soap+xml; charset=utf-8; action="{ns_wsdl}/{ACOES[servico]}"'}
    def _enviar():
        if ctx.data_dir is not None:
            cafile = tls.pacote_confianca(ctx.data_dir, ctx.ca_bundle)
            return tls.sessao(cafile).post(url, data=envelope.encode("utf-8"), headers=headers,
                                           cert=ctx.pem, timeout=ctx.timeout)
        return requests.post(url, data=envelope.encode("utf-8"), headers=headers, cert=ctx.pem,
                             timeout=ctx.timeout, verify=ctx.ca_bundle if ctx.ca_bundle else True)

    try:
        try:
            resp = _enviar()
        except requests.exceptions.SSLError:
            # Quase sempre é a cadeia ICP-Brasil que falta: baixa uma vez e tenta de novo.
            if ctx.data_dir is None or not ctx.auto_cadeia or tls.tem_cadeia(ctx.data_dir):
                raise
            try:
                tls.baixar_cadeia(ctx.data_dir)
            except tls.CadeiaErro as exc_cadeia:
                raise SefazErro(str(exc_cadeia)) from exc_cadeia
            resp = _enviar()
    except requests.exceptions.SSLError as exc:
        raise SefazErro(
            "Falha na conexão segura (TLS) com a SEFAZ. Em Configurações > Certificados de "
            "segurança da SEFAZ use \"Baixar cadeia ICP-Brasil\" (ou envie o arquivo "
            f"ACcompactado.zip do site do ITI). Detalhe: {str(exc)[-300:]}"
        ) from exc
    except requests.exceptions.Timeout as exc:
        raise SefazTimeout("A SEFAZ não respondeu a tempo.") from exc
    except requests.exceptions.RequestException as exc:
        raise SefazErro(f"Erro de rede ao falar com a SEFAZ: {str(exc)[:200]}") from exc

    try:
        raiz = etree.fromstring(resp.content)
    except etree.XMLSyntaxError as exc:
        raise SefazErro(f"Resposta inválida da SEFAZ (HTTP {resp.status_code}).") from exc

    falha = raiz.xpath("//*[local-name()='Fault']")
    if falha:
        detalhe = " ".join(t.strip() for t in falha[0].itertext() if t.strip())
        raise SefazErro(f"A SEFAZ devolveu um erro SOAP: {detalhe[:300]}")
    resultado = raiz.xpath("//*[local-name()='nfeResultMsg']")
    if not resultado:
        raise SefazErro(f"Resposta sem nfeResultMsg (HTTP {resp.status_code}).")
    filhos = [c for c in resultado[0] if isinstance(c.tag, str)]
    if not filhos:
        raise SefazErro("Resposta da SEFAZ vazia.")
    return filhos[0]


# ----------------------------------------------------------------------------------------
# Status do serviço
# ----------------------------------------------------------------------------------------
def status_servico(cuf: str, ctx: Contexto) -> dict:
    msg = (f'<consStatServ xmlns="{NS}" versao="4.00"><tpAmb>{ctx.ambiente}</tpAmb>'
           f'<cUF>{cuf}</cUF><xServ>STATUS</xServ></consStatServ>')
    ret = chamar("NFeStatusServico4", msg, ctx)
    return {"cstat": _txt(ret, "cStat"), "xmotivo": _txt(ret, "xMotivo"),
            "tempo_medio": _txt(ret, "tMed"), "resposta": para_texto(ret)}


# ----------------------------------------------------------------------------------------
# Autorização
# ----------------------------------------------------------------------------------------
def _interpretar_prot(prot, chave: str) -> dict:
    inf = _filho(prot, "infProt")
    if inf is None:
        raise SefazErro("Resposta sem protocolo (infProt).")
    cstat = _txt(inf, "cStat")
    if _txt(inf, "chNFe") not in (None, chave):
        raise SefazErro("O protocolo recebido é de outra chave de acesso.")
    if cstat in ("100", "150"):
        status = "autorizada"
    elif cstat in ("110", "301", "302", "303"):
        status = "denegada"
    else:
        status = "rejeitada"
    return {"status": status, "cstat": cstat, "xmotivo": _txt(inf, "xMotivo"),
            "protocolo": _txt(inf, "nProt"), "dh_autorizacao": _txt(inf, "dhRecbto"),
            "prot": prot}


def montar_nfe_proc(nfe_el, prot_el) -> str:
    proc = etree.Element(_t("nfeProc"), nsmap={None: NS}, versao="4.00")
    proc.append(copy.deepcopy(nfe_el))
    proc.append(copy.deepcopy(prot_el))
    return etree.tostring(proc, encoding="unicode")


def autorizar(nfe_el, chave: str, id_lote: str, ctx: Contexto) -> dict:
    """Envia a NF-e (modo síncrono) e acompanha o recibo se a SEFAZ processar de forma assíncrona."""
    msg = (f'<enviNFe xmlns="{NS}" versao="4.00"><idLote>{id_lote}</idLote>'
           f'<indSinc>1</indSinc>{serializar(nfe_el)}</enviNFe>')
    ret = chamar("NFeAutorizacao4", msg, ctx)
    cstat = _txt(ret, "cStat")
    recibo = None
    resposta = para_texto(ret)

    if cstat == "103":  # lote recebido, processamento assíncrono
        recibo = _txt(_filho(ret, "infRec"), "nRec")
        if not recibo:
            raise SefazErro("Lote recebido, mas a SEFAZ não informou o número do recibo.")
        for espera in (3, 3, 5, 5, 8, 8):
            time.sleep(espera)
            consulta = (f'<consReciNFe xmlns="{NS}" versao="4.00"><tpAmb>{ctx.ambiente}</tpAmb>'
                        f'<nRec>{recibo}</nRec></consReciNFe>')
            ret = chamar("NFeRetAutorizacao4", consulta, ctx)
            cstat = _txt(ret, "cStat")
            resposta = para_texto(ret)
            if cstat != "105":  # 105 = lote em processamento
                break
        else:
            raise SefazTimeout(f"Lote {recibo} ainda em processamento. Consulte a situação depois.")

    prot = _filho(ret, "protNFe")
    if cstat == "104" and prot is not None:
        resultado = _interpretar_prot(prot, chave)
    else:  # rejeição do lote inteiro (ex.: 225 falha no schema, 539 duplicidade...)
        resultado = {"status": "rejeitada", "cstat": cstat, "xmotivo": _txt(ret, "xMotivo"),
                    "protocolo": None, "dh_autorizacao": None, "prot": None}
    if resultado["status"] == "autorizada":
        resultado["xml_proc"] = montar_nfe_proc(nfe_el, resultado["prot"])
    resultado["recibo"] = recibo
    resultado["resposta"] = resposta
    resultado.pop("prot", None)
    return resultado


# ----------------------------------------------------------------------------------------
# Consulta por chave
# ----------------------------------------------------------------------------------------
def consultar_chave(chave: str, nfe_el, ctx: Contexto) -> dict:
    """Consulta a situação da NF-e. Se autorizada e `nfe_el` for informado, remonta o nfeProc."""
    msg = (f'<consSitNFe xmlns="{NS}" versao="4.00"><tpAmb>{ctx.ambiente}</tpAmb>'
           f'<xServ>CONSULTAR</xServ><chNFe>{chave}</chNFe></consSitNFe>')
    ret = chamar("NFeConsultaProtocolo4", msg, ctx)
    cstat = _txt(ret, "cStat")
    saida = {"cstat": cstat, "xmotivo": _txt(ret, "xMotivo"), "resposta": para_texto(ret),
             "status": None, "protocolo": None, "xml_proc": None, "dh_autorizacao": None}
    prot = _filho(ret, "protNFe")
    if cstat in ("100", "150") and prot is not None:
        r = _interpretar_prot(prot, chave)
        saida.update(status="autorizada", protocolo=r["protocolo"],
                     dh_autorizacao=r["dh_autorizacao"])
        if nfe_el is not None:
            saida["xml_proc"] = montar_nfe_proc(nfe_el, prot)
    elif cstat == "101":
        saida["status"] = "cancelada"
        for ev in ret.iter(_t("infEvento")):
            if _txt(ev, "tpEvento") == "110111" and _txt(ev, "cStat") in ("135", "155"):
                saida["cancel_protocolo"] = _txt(ev, "nProt")
    elif cstat in ("110", "301", "302", "303"):
        saida["status"] = "denegada"
    elif cstat == "217":  # NF-e não consta na base de dados da SEFAZ
        saida["status"] = "nao_encontrada"
    return saida


# ----------------------------------------------------------------------------------------
# Cancelamento (evento 110111)
# ----------------------------------------------------------------------------------------
def cancelar(*, cert: Certificado, cuf: str, cnpj: str, chave: str, protocolo: str,
             justificativa: str, dh_evento: datetime, ctx: Contexto, seq: int = 1) -> dict:
    justificativa = " ".join(justificativa.split())
    if not 15 <= len(justificativa) <= 255:
        raise ValueError("A justificativa do cancelamento deve ter entre 15 e 255 caracteres.")
    tp_evento = "110111"
    env = etree.Element(_t("envEvento"), nsmap={None: NS}, versao="1.00")
    _s(env, "idLote", "1")
    ev = etree.SubElement(env, _t("evento"), versao="1.00")
    inf = etree.SubElement(ev, _t("infEvento"), Id=f"ID{tp_evento}{chave}{seq:02d}")
    _s(inf, "cOrgao", cuf)
    _s(inf, "tpAmb", ctx.ambiente)
    _s(inf, "CNPJ", cnpj)
    _s(inf, "chNFe", chave)
    _s(inf, "dhEvento", dh_evento.isoformat(timespec="seconds"))
    _s(inf, "tpEvento", tp_evento)
    _s(inf, "nSeqEvento", str(seq))
    _s(inf, "verEvento", "1.00")
    det = etree.SubElement(inf, _t("detEvento"), versao="1.00")
    _s(det, "descEvento", "Cancelamento")
    _s(det, "nProt", protocolo)
    _s(det, "xJust", justificativa)
    assinar(ev, inf, cert)

    ret = chamar("NFeRecepcaoEvento4", etree.tostring(env, encoding="unicode"), ctx)
    ret_ev = _filho(ret, "retEvento")
    inf_ret = _filho(ret_ev, "infEvento")
    cstat = _txt(inf_ret, "cStat") or _txt(ret, "cStat")
    saida = {"cstat": cstat, "xmotivo": _txt(inf_ret, "xMotivo") or _txt(ret, "xMotivo"),
             "protocolo": _txt(inf_ret, "nProt"), "cancelada": cstat in ("135", "136", "155"),
             "xml_evento": None, "resposta": para_texto(ret)}
    if saida["cancelada"]:
        proc = etree.Element(_t("procEventoNFe"), nsmap={None: NS}, versao="1.00")
        proc.append(copy.deepcopy(ev))
        proc.append(copy.deepcopy(ret_ev))
        saida["xml_evento"] = etree.tostring(proc, encoding="unicode")
    return saida

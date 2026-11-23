"""Utilidades comuns aos conectores."""
import ipaddress
import re
import socket
from decimal import Decimal, InvalidOperation
from urllib.parse import urlparse

import requests

from ..nfe.util import so_digitos, validar_documento

TIMEOUT = 25
MAX_PAGINAS = 40          # trava de segurança contra paginação infinita
USER_AGENT = "EmissorNFe/1.0 (integracao de pedidos)"

# Os testes trocam isto por um objeto falso; em produção é o próprio requests.
http = requests


class ErroIntegracao(Exception):
    """Mensagem em português, segura para mostrar ao usuário."""


def dec(valor, padrao="0") -> str:
    """Converte número/str da API em string decimal com ponto."""
    try:
        return format(Decimal(str(valor if valor not in (None, "") else padrao).replace(",", ".")), "f")
    except InvalidOperation:
        return padrao


def requisitar(metodo: str, url: str, **kw):
    """Chama a API e devolve JSON; converte falhas em ErroIntegracao."""
    kw.setdefault("timeout", TIMEOUT)
    try:
        r = getattr(http, metodo)(url, **kw)
    except requests.RequestException as exc:
        raise ErroIntegracao(f"Não foi possível conectar à plataforma ({exc.__class__.__name__}).") from exc
    if r.status_code in (401, 403):
        raise ErroIntegracao("A plataforma recusou as credenciais (verifique token/chaves e permissões).")
    if r.status_code == 404:
        raise ErroIntegracao("Endereço ou loja não encontrado (confira os dados da loja).")
    if r.status_code == 429:
        raise ErroIntegracao("A plataforma limitou as requisições. Tente de novo em alguns minutos.")
    if r.status_code >= 400:
        raise ErroIntegracao(f"A plataforma respondeu com erro {r.status_code}.")
    try:
        return r, r.json()
    except ValueError as exc:
        raise ErroIntegracao("Resposta inesperada da plataforma (não é JSON).") from exc


def url_publica_https(url: str) -> str:
    """Aceita só https para hosts públicos (evita que o servidor fale com a rede interna)."""
    p = urlparse((url or "").strip())
    if p.scheme != "https" or not p.hostname:
        raise ErroIntegracao("Informe o endereço da loja começando com https://")
    host = p.hostname
    try:
        enderecos = {ipaddress.ip_address(host)}
    except ValueError:
        try:
            enderecos = {ipaddress.ip_address(i[4][0]) for i in socket.getaddrinfo(host, None)}
        except OSError:
            enderecos = set()      # sem DNS aqui: a chamada falhará adiante com mensagem própria
    if any(a.is_private or a.is_loopback or a.is_link_local or a.is_reserved for a in enderecos):
        raise ErroIntegracao("Endereço não permitido (rede interna).")
    return f"https://{p.netloc}{p.path.rstrip('/')}"


_PADRAO_DOC = re.compile(r"(?<![\dA-Za-z])(\d{3}\.?\d{3}\.?\d{3}-?\d{2}|\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2})(?![\dA-Za-z])")


def achar_documento(*textos) -> str:
    """Primeiro CPF/CNPJ válido encontrado nos textos (campo de documento, notas, atributos)."""
    for t in textos:
        if not t:
            continue
        t = str(t)
        d = so_digitos(t)
        if len(d) in (11, 14) and validar_documento(d) and len(t.strip()) <= 20:
            return d
        for m in _PADRAO_DOC.findall(t):
            d = so_digitos(m)
            if validar_documento(d):
                return d
    return ""


def separar_numero(endereco: str, numero: str = "") -> tuple[str, str]:
    """'Rua X, 123' -> ('Rua X', '123'). Se já veio o número, só devolve."""
    endereco = (endereco or "").strip()
    if numero:
        return endereco, str(numero).strip()
    m = re.match(r"^(.*?)[,\s]+(\d+\w?)\s*$", endereco)
    if m:
        return m.group(1).strip(" ,-"), m.group(2)
    return endereco, "S/N"


FORMAS = [("pix", "17"), ("boleto", "15"), ("bolbradesco", "15"), ("ticket", "15"),
          ("debit", "04"), ("debito", "04"), ("débito", "04"),
          ("credit", "03"), ("credito", "03"), ("crédito", "03"), ("card", "03"), ("cartao", "03"),
          ("cartão", "03"), ("visa", "03"), ("master", "03"), ("elo", "03"), ("amex", "03")]


def forma_pagamento(texto: str) -> str:
    t = (texto or "").lower()
    for chave, codigo in FORMAS:
        if chave in t:
            return codigo
    return "99"

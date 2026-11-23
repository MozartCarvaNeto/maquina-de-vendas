"""Mercado Livre (OAuth 2.0).

1. Crie um aplicativo em developers.mercadolivre.com.br e cadastre como URL de redirecionamento o
   endereço mostrado na tela Integrações deste sistema.
2. Preencha App ID e Secret e clique em "Autorizar no Mercado Livre".
O sistema guarda o refresh_token e renova o access_token sozinho (o refresh_token novo substitui o
anterior a cada renovação, por isso é regravado no banco).
Pedidos: GET https://api.mercadolibre.com/orders/search?seller={user_id}
CPF/CNPJ: buyer.billing_info.doc_number (e, se faltar, GET /orders/{id}/billing_info).
"""
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

from . import base
from .base import ErroIntegracao, achar_documento, dec, separar_numero

NOME = "Mercado Livre"
CAMPOS = [("client_id", "App ID (client_id)", False), ("client_secret", "Secret (client_secret)", True)]
API = "https://api.mercadolibre.com"
AUTORIZAR = "https://auth.mercadolivre.com.br/authorization"


def url_autorizacao(cfg, redirect_uri, state):
    return AUTORIZAR + "?" + urlencode({"response_type": "code", "client_id": cfg.get("client_id", ""),
                                        "redirect_uri": redirect_uri, "state": state})


def _guardar_tokens(cfg, dados):
    cfg["access_token"] = dados["access_token"]
    cfg["refresh_token"] = dados.get("refresh_token") or cfg.get("refresh_token", "")
    cfg["user_id"] = str(dados.get("user_id") or cfg.get("user_id", ""))
    cfg["expira_em"] = int(time.time()) + int(dados.get("expires_in", 21600)) - 120


def trocar_codigo(cfg, codigo, redirect_uri):
    _, dados = base.requisitar(
        "post", f"{API}/oauth/token", headers={"accept": "application/json"},
        data={"grant_type": "authorization_code", "client_id": cfg.get("client_id"),
              "client_secret": cfg.get("client_secret"), "code": codigo, "redirect_uri": redirect_uri})
    _guardar_tokens(cfg, dados)
    return cfg


def _token(cfg):
    """Devolve access_token válido; renova se necessário (altera cfg: o chamador deve regravar)."""
    if not cfg.get("refresh_token") and not cfg.get("access_token"):
        raise ErroIntegracao("Mercado Livre ainda não autorizado: clique em 'Autorizar no Mercado Livre'.")
    if cfg.get("access_token") and int(cfg.get("expira_em", 0)) > time.time():
        return cfg["access_token"]
    if not cfg.get("refresh_token"):
        raise ErroIntegracao("Autorização expirada: autorize novamente no Mercado Livre.")
    _, dados = base.requisitar(
        "post", f"{API}/oauth/token", headers={"accept": "application/json"},
        data={"grant_type": "refresh_token", "client_id": cfg.get("client_id"),
              "client_secret": cfg.get("client_secret"), "refresh_token": cfg["refresh_token"]})
    _guardar_tokens(cfg, dados)
    return cfg["access_token"]


def _cab(cfg):
    return {"Authorization": f"Bearer {_token(cfg)}", "User-Agent": base.USER_AGENT}


def testar(cfg):
    _, dados = base.requisitar("get", f"{API}/users/me", headers=_cab(cfg))
    cfg["user_id"] = str(dados.get("id") or cfg.get("user_id", ""))
    return f"Conexão com o Mercado Livre OK (conta {dados.get('nickname', cfg['user_id'])})."


def _doc_billing(cfg, o):
    b = (o.get("buyer") or {}).get("billing_info") or {}
    doc = achar_documento(b.get("doc_number"))
    if doc:
        return doc, b
    try:
        _, d2 = base.requisitar("get", f"{API}/orders/{o['id']}/billing_info", headers=_cab(cfg))
    except ErroIntegracao:
        return "", b
    info = d2.get("billing_info") or d2
    return achar_documento(info.get("doc_number")), {**b, **info}


def _endereco(cfg, o):
    end = (o.get("shipping") or {}).get("receiver_address") or {}
    if end.get("street_name") or not (o.get("shipping") or {}).get("id"):
        return end
    try:
        _, s = base.requisitar("get", f"{API}/shipments/{o['shipping']['id']}", headers=_cab(cfg))
    except ErroIntegracao:
        return end
    return s.get("receiver_address") or end


def _pedido(cfg, o):
    comprador = o.get("buyer") or {}
    doc, b = _doc_billing(cfg, o)
    end = _endereco(cfg, o)
    nome = (f"{b.get('name', '')} {b.get('last_name', '')}".strip() if b.get("name") else
            f"{comprador.get('first_name', '')} {comprador.get('last_name', '')}".strip()
            or comprador.get("nickname", ""))
    rua, num = separar_numero(end.get("street_name") or end.get("address_line") or "",
                              end.get("street_number") or "")
    uf = (end.get("state") or {}).get("id", "") if isinstance(end.get("state"), dict) else end.get("state", "")
    cidade = (end.get("city") or {}).get("name", "") if isinstance(end.get("city"), dict) else end.get("city", "")
    bairro = (end.get("neighborhood") or {}).get("name", "") if isinstance(end.get("neighborhood"), dict) \
        else end.get("neighborhood", "")
    itens = []
    for it in o.get("order_items") or []:
        item = it.get("item") or {}
        sku = item.get("seller_sku") or item.get("seller_custom_field") or ""
        itens.append({"sku": str(sku).strip(), "descricao": item.get("title") or "",
                      "quantidade": dec(it.get("quantity"), "1"), "preco": dec(it.get("unit_price"))})
    envio = ((o.get("shipping") or {}).get("cost")) or 0
    pagamentos = " ".join(str(p.get("payment_type") or p.get("payment_method_id") or "")
                          for p in o.get("payments") or [])
    return {
        "externo_id": str(o["id"]), "numero": str(o["id"]), "data": o.get("date_created") or "",
        "pago": o.get("status") == "paid", "total": dec(o.get("total_amount")), "frete": dec(envio),
        "desconto": "0", "pagamento": base.forma_pagamento(pagamentos), "obs": "",
        "cliente": {"documento": doc, "nome": nome, "email": "", "fone": "",
                    "cep": end.get("zip_code") or "", "logradouro": rua, "numero": num,
                    "complemento": end.get("comment") or "", "bairro": bairro,
                    "municipio": cidade, "uf": str(uf).replace("BR-", "")},
        "itens": itens,
        "marketplace": True,
    }


def buscar(cfg, dias=30):
    cab = _cab(cfg)
    if not cfg.get("user_id"):
        _, eu = base.requisitar("get", f"{API}/users/me", headers=cab)
        cfg["user_id"] = str(eu.get("id", ""))
    desde = (datetime.now(timezone.utc) - timedelta(days=dias)).strftime("%Y-%m-%dT%H:%M:%S.000-00:00")
    pedidos, offset = [], 0
    for _ in range(base.MAX_PAGINAS):
        _, dados = base.requisitar(
            "get", f"{API}/orders/search", headers=_cab(cfg),
            params={"seller": cfg["user_id"], "order.status": "paid", "order.date_created.from": desde,
                    "sort": "date_asc", "offset": offset, "limit": 50})
        lote = dados.get("results") or []
        pedidos += [_pedido(cfg, o) for o in lote]
        offset += len(lote)
        if not lote or offset >= int((dados.get("paging") or {}).get("total", 0)):
            break
    return pedidos

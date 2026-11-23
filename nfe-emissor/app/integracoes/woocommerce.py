"""WooCommerce REST API v3: GET /wp-json/wc/v3/orders (HTTP Basic com consumer key/secret, via HTTPS).

CPF/CNPJ não existem no WooCommerce puro: plugins brasileiros (ex.: Brazilian Market) gravam em
billing_cpf / billing_cnpj (meta _billing_cpf / _billing_cnpj) e número/bairro em billing_number /
billing_neighborhood. O conector procura em todos esses lugares.
"""
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from . import base
from .base import ErroIntegracao, achar_documento, dec, separar_numero, url_publica_https

NOME = "WooCommerce"
CAMPOS = [("url", "Endereço da loja (https://...)", False),
          ("consumer_key", "Consumer key (ck_...)", False),
          ("consumer_secret", "Consumer secret (cs_...)", True)]


def _api(cfg):
    return url_publica_https(cfg.get("url", "")) + "/wp-json/wc/v3"


def _auth(cfg):
    if not cfg.get("consumer_key") or not cfg.get("consumer_secret"):
        raise ErroIntegracao("Preencha a consumer key e o consumer secret.")
    return (cfg["consumer_key"], cfg["consumer_secret"])


def testar(cfg):
    base.requisitar("get", _api(cfg) + "/orders", auth=_auth(cfg), params={"per_page": 1},
                    headers={"User-Agent": base.USER_AGENT})
    return "Conexão com o WooCommerce OK."


def _meta(o, *chaves):
    achados = []
    for m in o.get("meta_data") or []:
        k = str(m.get("key", "")).lower().lstrip("_")
        if k in chaves and isinstance(m.get("value"), (str, int)):
            achados.append(str(m["value"]))
    return achados


def _pedido(o):
    b = o.get("billing") or {}
    s = o.get("shipping") or {}
    doc = achar_documento(b.get("cpf"), b.get("cnpj"), *_meta(o, "billing_cpf", "billing_cnpj", "billing_persontype_doc"),
                          b.get("company"))
    nome = (b.get("company") if len(doc) == 14 and b.get("company") else
            f"{b.get('first_name', '')} {b.get('last_name', '')}".strip())
    # endereço de entrega, se houver; senão cobrança
    fonte = s if s.get("address_1") else b
    num_extra = (_meta(o, "billing_number" if fonte is b else "shipping_number") or [""])[0] \
        or fonte.get("number") or ""
    bairro_extra = (_meta(o, "billing_neighborhood" if fonte is b else "shipping_neighborhood") or [""])[0] \
        or fonte.get("neighborhood") or ""
    rua, num = separar_numero(fonte.get("address_1") or "", num_extra)
    bairro = bairro_extra or fonte.get("address_2") or ""
    compl = fonte.get("address_2") if bairro_extra else ""
    itens = []
    for li in o.get("line_items") or []:
        qtd = dec(li.get("quantity"), "1")
        subtotal = dec(li.get("subtotal"))
        unit = format(Decimal(subtotal) / Decimal(qtd), "f") \
            if Decimal(qtd) else dec(li.get("price"))
        itens.append({"sku": (li.get("sku") or "").strip(), "descricao": li.get("name") or "",
                      "quantidade": qtd, "preco": unit})
    return {
        "externo_id": str(o["id"]), "numero": str(o.get("number") or o["id"]),
        "data": o.get("date_created") or "", "pago": bool(o.get("date_paid")) or o.get("status") in ("processing", "completed"),
        "total": dec(o.get("total")), "frete": dec(o.get("shipping_total")),
        "desconto": dec(o.get("discount_total")),
        "pagamento": base.forma_pagamento(f"{o.get('payment_method', '')} {o.get('payment_method_title', '')}"),
        "obs": o.get("customer_note") or "",
        "cliente": {"documento": doc, "nome": nome or b.get("email", ""), "email": b.get("email") or "",
                    "fone": b.get("phone") or "", "cep": fonte.get("postcode") or "",
                    "logradouro": rua, "numero": num, "complemento": compl or "",
                    "bairro": bairro, "municipio": fonte.get("city") or "", "uf": fonte.get("state") or ""},
        "itens": itens,
    }


def buscar(cfg, dias=30):
    api, auth = _api(cfg), _auth(cfg)
    desde = (datetime.now(timezone.utc) - timedelta(days=dias)).strftime("%Y-%m-%dT%H:%M:%S")
    pedidos = []
    for pagina in range(1, base.MAX_PAGINAS + 1):
        r, dados = base.requisitar(
            "get", api + "/orders", auth=auth, headers={"User-Agent": base.USER_AGENT},
            params={"after": desde, "per_page": 50,
                    "page": pagina, "orderby": "date", "order": "asc"})
        if not isinstance(dados, list):
            break
        pedidos += [_pedido(o) for o in dados if o.get("status") in ("processing", "completed")]
        if len(dados) < 50:
            break
    return pedidos

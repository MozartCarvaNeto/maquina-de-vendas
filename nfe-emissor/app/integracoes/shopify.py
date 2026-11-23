"""Shopify Admin GraphQL API (a REST Admin API é legada desde 2024-10).

POST https://{loja}.myshopify.com/admin/api/{versão}/graphql.json  com  X-Shopify-Access-Token.
Precisa do escopo read_orders e, para nome/endereço/telefone do cliente, de acesso a
"dados protegidos de clientes" liberado no app (painel de desenvolvedor da Shopify).
Shopify não tem campo de CPF/CNPJ: procura-se no campo "empresa" do endereço, nos atributos do
pedido e na nota do pedido (formato 000.000.000-00 ou 11/14 dígitos).
"""
import re
from datetime import datetime, timedelta, timezone

from . import base
from .base import ErroIntegracao, achar_documento, dec, separar_numero

NOME = "Shopify"
CAMPOS = [("loja", "Endereço da loja (minhaloja.myshopify.com)", False),
          ("access_token", "Token de acesso da Admin API (shpat_...)", True),
          ("versao", "Versão da API (ex.: 2026-07)", False)]
VERSAO_PADRAO = "2026-07"

CONSULTA = """
query($cursor: String, $q: String) {
  orders(first: 50, after: $cursor, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt email phone note displayFinancialStatus paymentGatewayNames
      customAttributes { key value }
      customer { firstName lastName email phone }
      billingAddress { name company phone }
      shippingAddress { name company phone address1 address2 city provinceCode zip }
      totalDiscountsSet { shopMoney { amount currencyCode } }
      totalShippingPriceSet { shopMoney { amount currencyCode } }
      totalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 100) { nodes { name sku quantity originalUnitPriceSet { shopMoney { amount } } } }
    }
  }
}
"""


def _endpoint(cfg):
    loja = (cfg.get("loja") or "").strip().lower().removeprefix("https://").strip("/")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*\.myshopify\.com", loja):
        raise ErroIntegracao("Informe o endereço da loja no formato minhaloja.myshopify.com.")
    if not cfg.get("access_token"):
        raise ErroIntegracao("Preencha o token de acesso.")
    versao = (cfg.get("versao") or VERSAO_PADRAO).strip()
    if not re.fullmatch(r"\d{4}-\d{2}", versao):
        raise ErroIntegracao("Versão da API inválida (use o formato 2026-07).")
    return f"https://{loja}/admin/api/{versao}/graphql.json"


def _gql(cfg, consulta, variaveis=None):
    r, dados = base.requisitar(
        "post", _endpoint(cfg), json={"query": consulta, "variables": variaveis or {}},
        headers={"X-Shopify-Access-Token": cfg["access_token"], "Content-Type": "application/json",
                 "User-Agent": base.USER_AGENT})
    if dados.get("errors"):
        msg = "; ".join(str(e.get("message", e)) for e in dados["errors"])[:300] \
            if isinstance(dados["errors"], list) else str(dados["errors"])[:300]
        raise ErroIntegracao(f"A Shopify recusou a consulta: {msg}")
    return dados.get("data") or {}


def testar(cfg):
    _gql(cfg, "{ shop { name } }")
    return "Conexão com a Shopify OK."


def _valor(conj):
    return dec(((conj or {}).get("shopMoney") or {}).get("amount"))


def _pedido(o):
    cli = o.get("customer") or {}
    env = o.get("shippingAddress") or {}
    cob = o.get("billingAddress") or {}
    attrs = [a.get("value") for a in o.get("customAttributes") or []]
    doc = achar_documento(env.get("company"), cob.get("company"), *attrs, o.get("note"))
    nome = env.get("name") or cob.get("name") or f"{cli.get('firstName', '')} {cli.get('lastName', '')}".strip()
    rua, num = separar_numero(env.get("address1") or "")
    moeda = (((o.get("totalPriceSet") or {}).get("shopMoney") or {}).get("currencyCode")) or "BRL"
    if moeda != "BRL":
        raise ErroIntegracao(f"Pedido {o.get('name')} está em {moeda}; só BRL é suportado.")
    gid = str(o["id"]).rsplit("/", 1)[-1]
    itens = [{"sku": (li.get("sku") or "").strip(), "descricao": li.get("name") or "",
              "quantidade": dec(li.get("quantity"), "1"),
              "preco": dec(((li.get("originalUnitPriceSet") or {}).get("shopMoney") or {}).get("amount"))}
             for li in (o.get("lineItems") or {}).get("nodes") or []]
    return {
        "externo_id": gid, "numero": str(o.get("name") or gid).lstrip("#"), "data": o.get("createdAt") or "",
        "pago": o.get("displayFinancialStatus") == "PAID",
        "total": _valor(o.get("totalPriceSet")), "frete": _valor(o.get("totalShippingPriceSet")),
        "desconto": _valor(o.get("totalDiscountsSet")),
        "pagamento": base.forma_pagamento(" ".join(o.get("paymentGatewayNames") or [])),
        "obs": o.get("note") or "",
        "cliente": {"documento": doc, "nome": nome, "email": o.get("email") or cli.get("email") or "",
                    "fone": o.get("phone") or env.get("phone") or cli.get("phone") or "",
                    "cep": env.get("zip") or "", "logradouro": rua, "numero": num,
                    "complemento": env.get("address2") or "", "bairro": "",
                    "municipio": env.get("city") or "", "uf": env.get("provinceCode") or ""},
        "itens": itens,
    }


def buscar(cfg, dias=30):
    desde = (datetime.now(timezone.utc) - timedelta(days=dias)).strftime("%Y-%m-%d")
    filtro = f"created_at:>={desde} financial_status:paid"
    pedidos, cursor = [], None
    for _ in range(base.MAX_PAGINAS):
        dados = _gql(cfg, CONSULTA, {"cursor": cursor, "q": filtro})
        bloco = dados.get("orders") or {}
        pedidos += [_pedido(o) for o in bloco.get("nodes") or []]
        info = bloco.get("pageInfo") or {}
        if not info.get("hasNextPage"):
            break
        cursor = info.get("endCursor")
    return pedidos

"""Nuvemshop (Tiendanube). API REST v1.

Autenticação: o app/token da loja. Documentação: https://tiendanube.github.io/api-documentation/
Listagem: GET /v1/{store_id}/orders?created_at_min=...&payment_status=paid&per_page=&page=
"""
from datetime import datetime, timedelta, timezone

from . import base
from .base import ErroIntegracao, achar_documento, dec, separar_numero

NOME = "Nuvemshop"
CAMPOS = [("store_id", "ID da loja", False), ("access_token", "Token de acesso (access_token)", True)]
API = "https://api.nuvemshop.com.br/v1"


def _cabecalhos(cfg):
    token = cfg["access_token"]
    # A documentação da Nuvemshop usa o cabeçalho "Authentication: bearer"; enviamos também o
    # padrão "Authorization" por compatibilidade. User-Agent é obrigatório.
    return {"Authentication": f"bearer {token}", "Authorization": f"Bearer {token}",
            "User-Agent": base.USER_AGENT, "Content-Type": "application/json"}


def _validar(cfg):
    if not str(cfg.get("store_id", "")).isdigit() or not cfg.get("access_token"):
        raise ErroIntegracao("Preencha o ID da loja (só números) e o token de acesso.")


def testar(cfg):
    _validar(cfg)
    base.requisitar("get", f"{API}/{cfg['store_id']}/orders", headers=_cabecalhos(cfg),
                    params={"per_page": 1})
    return "Conexão com a Nuvemshop OK."


def _pedido(o):
    nome = o.get("contact_name") or o.get("billing_name") or ""
    end = o.get("shipping_address") or {}
    rua = end.get("address") or o.get("billing_address") or ""
    num = end.get("number") or o.get("billing_number") or ""
    rua, num = separar_numero(rua, num)
    doc = achar_documento(o.get("contact_identification"), o.get("billing_document"),
                          o.get("note"))
    itens = [{"sku": (p.get("sku") or "").strip(), "descricao": p.get("name") or "",
              "quantidade": dec(p.get("quantity"), "1"), "preco": dec(p.get("price"))}
             for p in o.get("products") or []]
    return {
        "externo_id": str(o["id"]), "numero": str(o.get("number") or o["id"]),
        "data": o.get("created_at") or "", "pago": o.get("payment_status") == "paid",
        "total": dec(o.get("total")), "frete": dec(o.get("shipping_cost_customer")),
        "desconto": dec(o.get("discount")),
        "pagamento": base.forma_pagamento(o.get("gateway") or ""),
        "obs": o.get("note") or "",
        "cliente": {
            "documento": doc, "nome": nome, "email": o.get("contact_email") or "",
            "fone": o.get("contact_phone") or o.get("billing_phone") or "",
            "cep": end.get("zipcode") or o.get("billing_zipcode") or "",
            "logradouro": rua, "numero": num, "complemento": end.get("floor") or o.get("billing_floor") or "",
            "bairro": end.get("locality") or o.get("billing_locality") or "",
            "municipio": end.get("city") or o.get("billing_city") or "",
            "uf": (end.get("province") or o.get("billing_province") or ""),
        },
        "itens": itens,
    }


def buscar(cfg, dias=30):
    _validar(cfg)
    desde = (datetime.now(timezone.utc) - timedelta(days=dias)).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    pedidos = []
    for pagina in range(1, base.MAX_PAGINAS + 1):
        r, dados = base.requisitar(
            "get", f"{API}/{cfg['store_id']}/orders", headers=_cabecalhos(cfg),
            params={"created_at_min": desde, "payment_status": "paid", "status": "open",
                    "per_page": 50, "page": pagina})
        if not isinstance(dados, list):
            break              # a API devolve objeto de erro/ lista vazia ao passar da última página
        pedidos += [_pedido(o) for o in dados]
        if len(dados) < 50:
            break
    return pedidos

"""Transforma pedidos normalizados em clientes + rascunhos de nota."""
import hashlib
import json
from decimal import Decimal

import requests

from .. import security
from ..nfe import tabelas as T
from ..nfe.util import limpar_texto, so_digitos, validar_documento
from . import PLATAFORMAS
from .base import ErroIntegracao


# ---------------------------------------------------------------- credenciais
def carregar_config(db, plataforma) -> dict:
    row = db.execute("SELECT config_enc FROM integracoes WHERE plataforma = ?", (plataforma,)).fetchone()
    if not row or not row["config_enc"]:
        return {}
    return json.loads(security.decifrar(row["config_enc"]))


def salvar_config(db, plataforma, cfg: dict):
    enc = security.cifrar(json.dumps(cfg))
    db.execute("INSERT INTO integracoes (plataforma, config_enc) VALUES (?, ?) "
               "ON CONFLICT(plataforma) DO UPDATE SET config_enc = excluded.config_enc, "
               "atualizado_em = CURRENT_TIMESTAMP", (plataforma, enc))
    db.commit()


# ---------------------------------------------------------------- CEP
def consultar_cep(cep: str) -> dict:
    cep = so_digitos(cep)
    if len(cep) != 8:
        return {}
    try:
        d = requests.get(f"https://viacep.com.br/ws/{cep}/json/", timeout=6).json()
    except Exception:
        return {}
    return {} if d.get("erro") else d


# ---------------------------------------------------------------- cliente
def _cliente(db, c, cep_fn, avisos):
    doc = c["documento"]
    existente = db.execute("SELECT id FROM clientes WHERE documento = ?", (doc,)).fetchone()
    if existente:
        return existente["id"]
    cep = so_digitos(c["cep"])
    viacep = cep_fn(cep) if cep else {}
    d = {
        "documento": doc, "nome": limpar_texto(c["nome"], 60) or "CONSUMIDOR",
        "ind_ie_dest": "9", "ie": "", "email": limpar_texto(c["email"], 60),
        "fone": so_digitos(c["fone"])[:14],
        "logradouro": limpar_texto(c["logradouro"] or viacep.get("logradouro", ""), 60),
        "numero": limpar_texto(c["numero"], 60) or "S/N",
        "complemento": limpar_texto(c["complemento"], 60),
        "bairro": limpar_texto(c["bairro"] or viacep.get("bairro", ""), 60) or "CENTRO",
        "cod_municipio": so_digitos(viacep.get("ibge", "")),
        "municipio": limpar_texto(viacep.get("localidade") or c["municipio"], 60),
        "uf": (viacep.get("uf") or c["uf"]).upper()[:2], "cep": cep,
    }
    if len(d["cod_municipio"]) != 7:
        avisos.append("código IBGE do município não encontrado: abra o cliente e use Buscar CEP")
    if d["uf"] not in T.UF_CODIGO:
        avisos.append("UF do cliente inválida")
    cols = list(d)
    cur = db.execute(f"INSERT INTO clientes ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                     list(d.values()))
    return cur.lastrowid


# ---------------------------------------------------------------- produtos
def _produto(db, it, avisos):
    sku = it["sku"]
    prod = None
    if sku:
        prod = db.execute("SELECT * FROM produtos WHERE lower(codigo) = lower(?)", (sku,)).fetchone()
    if prod is None:
        codigo = sku or "IMP-" + hashlib.sha1(it["descricao"].encode()).hexdigest()[:8].upper()
        prod = db.execute("SELECT * FROM produtos WHERE codigo = ?", (codigo,)).fetchone()
    if prod is None:
        cur = db.execute("INSERT INTO produtos (codigo, descricao, ncm, preco) VALUES (?,?,?,?)",
                         (codigo, limpar_texto(it["descricao"], 120) or codigo, "", it["preco"]))
        prod = db.execute("SELECT * FROM produtos WHERE id = ?", (cur.lastrowid,)).fetchone()
        avisos.append(f"produto novo '{codigo}' criado sem NCM: complete em Produtos")
    elif not (prod["ncm"] or "").strip():
        avisos.append(f"produto '{prod['codigo']}' está sem NCM")
    return prod


def _item_nota(prod, it):
    return {"produto_id": prod["id"], "codigo": prod["codigo"], "descricao": prod["descricao"],
            "ncm": prod["ncm"], "cest": prod["cest"], "ean": prod["ean"], "cfop": prod["cfop"],
            "unidade": prod["unidade"], "quantidade": it["quantidade"], "valor_unitario": it["preco"],
            "origem": prod["origem"], "cst_icms": prod["cst_icms"], "aliq_icms": prod["aliq_icms"],
            "cst_pis": prod["cst_pis"], "aliq_pis": prod["aliq_pis"],
            "cst_cofins": prod["cst_cofins"], "aliq_cofins": prod["aliq_cofins"]}


# ---------------------------------------------------------------- importação
def importar_pedido(db, plataforma, p, empresa, salvar_nota, cep_fn=None):
    cep_fn = cep_fn or consultar_cep
    """Devolve ('ok'|'duplicado'|'ignorado', mensagem). salvar_nota(db, None, d, itens) -> nota_id."""
    ja = db.execute("SELECT 1 FROM pedidos_importados WHERE plataforma=? AND externo_id=?",
                    (plataforma, p["externo_id"])).fetchone()
    if ja:
        return "duplicado", ""
    c = p["cliente"]
    doc = c["documento"]
    if not doc or not validar_documento(doc):
        return "ignorado", f"Pedido {p['numero']}: sem CPF/CNPJ válido do cliente"
    if not p["itens"]:
        return "ignorado", f"Pedido {p['numero']}: sem itens"
    avisos = []
    cliente_id = _cliente(db, {**c, "documento": doc}, cep_fn, avisos)
    itens = [_item_nota(_produto(db, it, avisos), it) for it in p["itens"]]
    frete, desc = Decimal(p["frete"]), Decimal(p["desconto"])
    soma = sum(Decimal(i["quantidade"]) * Decimal(i["valor_unitario"]) for i in itens)
    esperado = soma + frete - desc
    if Decimal(p["total"]) and abs(esperado - Decimal(p["total"])) > Decimal("0.05"):
        avisos.append(f"total da nota (R$ {esperado:.2f}) difere do total do pedido "
                      f"(R$ {Decimal(p['total']):.2f}): confira frete/descontos/taxas")
    rotulo = {"nuvemshop": "Nuvemshop", "shopify": "Shopify", "woocommerce": "WooCommerce",
              "mercadolivre": "Mercado Livre"}[plataforma]
    d = {
        "cliente_id": cliente_id, "nat_op": empresa["nat_op_padrao"] or "VENDA DE MERCADORIA",
        "ind_final": "1", "ind_pres": "2",
        "ind_intermed": "0", "intermed_cnpj": "", "intermed_id": "",
        "mod_frete": "0" if frete > 0 else "9", "forma_pagto": p["pagamento"],
        "valor_frete": format(frete, "f"), "valor_desconto": format(desc, "f"), "valor_outras": "0.00",
        "info_adicional": limpar_texto(f"Pedido {rotulo} n {p['numero']}", 2000),
    }
    nota_id = salvar_nota(db, None, d, itens)
    if p.get("marketplace"):
        avisos.append("venda em marketplace: se o Mercado Livre intermediou, informe o intermediador na nota")
    db.execute("INSERT INTO pedidos_importados (plataforma, externo_id, numero, nota_id, avisos) "
               "VALUES (?,?,?,?,?)", (plataforma, p["externo_id"], p["numero"], nota_id, "; ".join(avisos)))
    db.commit()
    return "ok", "; ".join(avisos)


def importar(db, plataforma, empresa, salvar_nota, dias=30, cep_fn=None):
    mod = PLATAFORMAS[plataforma]
    cfg = carregar_config(db, plataforma)
    if not cfg:
        raise ErroIntegracao("Configure e salve as credenciais desta plataforma primeiro.")
    try:
        pedidos = mod.buscar(cfg, dias)
    finally:
        if plataforma == "mercadolivre" and cfg:      # tokens podem ter sido renovados
            salvar_config(db, plataforma, cfg)
    res = {"novos": 0, "duplicados": 0, "ignorados": [], "avisos": []}
    for p in pedidos:
        status, msg = importar_pedido(db, plataforma, p, empresa, salvar_nota, cep_fn)
        if status == "ok":
            res["novos"] += 1
            if msg:
                res["avisos"].append(f"Pedido {p['numero']}: {msg}")
        elif status == "duplicado":
            res["duplicados"] += 1
        else:
            res["ignorados"].append(msg)
    db.execute("UPDATE integracoes SET ultima_importacao = CURRENT_TIMESTAMP WHERE plataforma = ?",
               (plataforma,))
    db.commit()
    return res

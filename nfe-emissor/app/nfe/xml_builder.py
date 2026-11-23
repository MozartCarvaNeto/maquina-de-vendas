"""Montagem do XML da NF-e (modelo 55, leiaute 4.00).

ATENÇÃO: o leiaute da NF-e muda com Notas Técnicas (ex.: reforma tributária IBS/CBS, que
para o Simples Nacional entra em produção a partir de 14/12/2026 - confirme no Portal
Nacional da NF-e). Toda a estrutura do XML está neste arquivo; novos grupos devem ser
acrescentados aqui, respeitando a ORDEM dos elementos do XSD oficial.
"""
from datetime import datetime

from lxml import etree

from .chave import montar_chave
from .tabelas import ICMS_NORMAL, ICMS_SIMPLES, UF_CODIGO
from .util import (D, ZERO, fmt2, fmt4, fmt_aliq, fmt_unit, limpar_texto, normalizar_cnpj,
                   parse_decimal, q2, q4, so_digitos, validar_cnpj, validar_documento)

NS = "http://www.portalfiscal.inf.br/nfe"
VERSAO = "4.00"
HOMOLOG_NOME = "NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL"
CSOSN_VALIDOS = {c for c, _ in ICMS_SIMPLES}
CST_NORMAL_VALIDOS = {c for c, _ in ICMS_NORMAL}


class DadosInvalidos(Exception):
    def __init__(self, erros: list[str]):
        self.erros = erros
        super().__init__("; ".join(erros))


def _tag(nome: str) -> str:
    return f"{{{NS}}}{nome}"


def _sub(pai, nome: str, texto=None, **attrs):
    el = etree.SubElement(pai, _tag(nome), **attrs)
    if texto is not None:
        el.text = str(texto)
    return el


# ----------------------------------------------------------------------------------------
# Validação
# ----------------------------------------------------------------------------------------
def cfop_efetivo(cfop: str, uf_emit: str, uf_dest: str) -> str:
    """Ajusta o primeiro dígito do CFOP conforme a operação seja interna (5) ou interestadual (6)."""
    cfop = so_digitos(cfop)
    if len(cfop) != 4 or cfop[0] not in "56":
        return cfop
    if uf_emit != uf_dest and cfop[0] == "5":
        return "6" + cfop[1:]
    if uf_emit == uf_dest and cfop[0] == "6":
        return "5" + cfop[1:]
    return cfop


def validar_dados(empresa: dict, cliente: dict | None, itens: list[dict], nota: dict) -> list[str]:
    erros: list[str] = []
    e = empresa

    if not validar_cnpj(e.get("cnpj") or ""):
        erros.append("Empresa: CNPJ inválido.")
    for campo, nome in [("razao_social", "razão social"), ("ie", "inscrição estadual"),
                        ("logradouro", "logradouro"), ("numero", "número do endereço"),
                        ("bairro", "bairro"), ("municipio", "município")]:
        if not limpar_texto(e.get(campo)):
            erros.append(f"Empresa: preencha {nome}.")
    if len(so_digitos(e.get("cod_municipio"))) != 7:
        erros.append("Empresa: código do município (IBGE) deve ter 7 dígitos.")
    if len(so_digitos(e.get("cep"))) != 8:
        erros.append("Empresa: CEP deve ter 8 dígitos.")
    if e.get("uf") not in UF_CODIGO:
        erros.append("Empresa: UF inválida.")
    if str(e.get("crt")) not in ("1", "2", "3"):
        erros.append("Empresa: regime tributário (CRT) inválido.")

    if not cliente:
        erros.append("Selecione o cliente (destinatário).")
    else:
        if not validar_documento(cliente.get("documento") or ""):
            erros.append("Cliente: CPF/CNPJ inválido.")
        if not limpar_texto(cliente.get("nome")):
            erros.append("Cliente: preencha o nome.")
        for campo, nome in [("logradouro", "logradouro"), ("numero", "número"),
                            ("bairro", "bairro"), ("municipio", "município")]:
            if not limpar_texto(cliente.get(campo)):
                erros.append(f"Cliente: preencha {nome}.")
        if len(so_digitos(cliente.get("cod_municipio"))) != 7:
            erros.append("Cliente: código do município (IBGE) deve ter 7 dígitos.")
        if len(so_digitos(cliente.get("cep"))) != 8:
            erros.append("Cliente: CEP deve ter 8 dígitos.")
        if cliente.get("uf") not in UF_CODIGO:
            erros.append("Cliente: UF inválida.")
        if str(cliente.get("ind_ie_dest")) == "1" and not so_digitos(cliente.get("ie")):
            erros.append("Cliente contribuinte do ICMS precisa de Inscrição Estadual.")

    if not itens:
        erros.append("Adicione ao menos um item.")
    crt = str(e.get("crt"))
    for n, it in enumerate(itens, start=1):
        pre = f"Item {n} ({it.get('codigo') or '?'}): "
        if not limpar_texto(it.get("descricao")):
            erros.append(pre + "descrição vazia.")
        if len(so_digitos(it.get("ncm"))) != 8:
            erros.append(pre + "NCM deve ter 8 dígitos.")
        if len(so_digitos(it.get("cfop"))) != 4:
            erros.append(pre + "CFOP deve ter 4 dígitos.")
        try:
            if parse_decimal(it.get("quantidade"), D(0)) <= 0:
                erros.append(pre + "quantidade deve ser maior que zero.")
            if parse_decimal(it.get("valor_unitario"), D(-1)) < 0:
                erros.append(pre + "valor unitário inválido.")
        except ValueError as exc:
            erros.append(pre + str(exc))
        cst = str(it.get("cst_icms"))
        if crt in ("1", "2") and cst not in CSOSN_VALIDOS:
            erros.append(pre + f"CSOSN {cst} não é suportado (use {', '.join(sorted(CSOSN_VALIDOS))}).")
        if crt == "3" and cst not in CST_NORMAL_VALIDOS:
            erros.append(pre + f"CST {cst} não é suportado (use {', '.join(sorted(CST_NORMAL_VALIDOS))}).")
        ean = so_digitos(it.get("ean"))
        if ean and len(ean) not in (8, 12, 13, 14):
            erros.append(pre + "GTIN/EAN deve ter 8, 12, 13 ou 14 dígitos (ou ficar vazio).")
    return erros


# ----------------------------------------------------------------------------------------
# Cálculos (rateios e impostos)
# ----------------------------------------------------------------------------------------
def _ratear(total: D, bases: list[D]) -> list[D]:
    soma = sum(bases, D(0))
    if total == 0 or soma == 0:
        return [ZERO] * len(bases)
    saida, acumulado = [], D(0)
    for i, base in enumerate(bases):
        valor = total - acumulado if i == len(bases) - 1 else q2(total * base / soma)
        saida.append(valor)
        acumulado += valor
    return saida


def calcular(empresa: dict, cliente: dict, itens: list[dict], nota: dict) -> dict:
    crt = str(empresa["crt"])
    uf_emit, uf_dest = empresa["uf"], cliente["uf"]
    linhas = []
    for it in itens:
        qtd = q4(parse_decimal(it["quantidade"]))
        vun = parse_decimal(it["valor_unitario"])
        linhas.append({"it": it, "qtd": qtd, "vun": vun, "vprod": q2(qtd * vun)})

    bases = [ln["vprod"] for ln in linhas]
    frete = q2(parse_decimal(nota.get("valor_frete"), ZERO))
    outras = q2(parse_decimal(nota.get("valor_outras"), ZERO))
    desc = q2(parse_decimal(nota.get("valor_desconto"), ZERO))
    if desc > sum(bases, D(0)):
        raise DadosInvalidos(["O desconto não pode ser maior que o total dos produtos."])
    for ln, f, o, d in zip(linhas, _ratear(frete, bases), _ratear(outras, bases),
                           _ratear(desc, bases)):
        ln.update(vfrete=f, voutro=o, vdesc=d)
        ln["base"] = ln["vprod"] - d + f + o
        ln["cfop"] = cfop_efetivo(ln["it"]["cfop"], uf_emit, uf_dest)

        it = ln["it"]
        cst = str(it["cst_icms"])
        aliq = parse_decimal(it.get("aliq_icms"), D(0))
        ln.update(icms_bc=ZERO, icms_v=ZERO, cred_v=ZERO, cred_aliq=aliq)
        if crt == "3" and cst == "00":
            ln["icms_bc"] = q2(ln["base"])
            ln["icms_v"] = q2(ln["base"] * aliq / 100)
        if crt in ("1", "2") and cst == "101":
            ln["cred_v"] = q2(ln["base"] * aliq / 100)

        for nome in ("pis", "cofins"):
            cst_i = str(it.get(f"cst_{nome}"))
            aliq_i = parse_decimal(it.get(f"aliq_{nome}"), D(0))
            if cst_i in ("01", "02") or aliq_i > 0:
                bc, valor = q2(ln["base"]), q2(ln["base"] * aliq_i / 100)
            else:
                bc, valor = ZERO, ZERO
            ln[f"{nome}_bc"], ln[f"{nome}_a"], ln[f"{nome}_v"] = bc, aliq_i, valor

    tot = {
        "vBC": sum((ln["icms_bc"] for ln in linhas), ZERO),
        "vICMS": sum((ln["icms_v"] for ln in linhas), ZERO),
        "vProd": sum((ln["vprod"] for ln in linhas), ZERO),
        "vFrete": sum((ln["vfrete"] for ln in linhas), ZERO),
        "vDesc": sum((ln["vdesc"] for ln in linhas), ZERO),
        "vPIS": sum((ln["pis_v"] for ln in linhas), ZERO),
        "vCOFINS": sum((ln["cofins_v"] for ln in linhas), ZERO),
        "vOutro": sum((ln["voutro"] for ln in linhas), ZERO),
    }
    tot["vNF"] = tot["vProd"] - tot["vDesc"] + tot["vFrete"] + tot["vOutro"]
    return {"linhas": linhas, "totais": tot}


def _texto_credito_sn(linhas: list[dict]) -> str:
    por_aliq: dict[D, D] = {}
    for ln in linhas:
        if ln["cred_v"] > 0:
            por_aliq[ln["cred_aliq"]] = por_aliq.get(ln["cred_aliq"], ZERO) + ln["cred_v"]
    partes = []
    for aliq, valor in por_aliq.items():
        a = f"{aliq:.2f}".replace(".", ",")
        v = f"{valor:.2f}".replace(".", ",")
        partes.append(f"PERMITE O APROVEITAMENTO DO CREDITO DE ICMS CORRESPONDENTE A ALIQUOTA "
                      f"DE {a}%, NO VALOR DE R$ {v}, NOS TERMOS DO ART. 23 DA LC 123/2006")
    return "; ".join(partes)


# ----------------------------------------------------------------------------------------
# XML
# ----------------------------------------------------------------------------------------
def _grupo_icms(imposto, crt: str, ln: dict):
    it = ln["it"]
    cst, orig = str(it["cst_icms"]), str(it.get("origem") or "0")
    icms = _sub(imposto, "ICMS")
    if crt in ("1", "2"):
        if cst == "101":
            g = _sub(icms, "ICMSSN101")
            _sub(g, "orig", orig)
            _sub(g, "CSOSN", cst)
            _sub(g, "pCredSN", fmt_aliq(ln["cred_aliq"]))
            _sub(g, "vCredICMSSN", fmt2(ln["cred_v"]))
        else:  # 102, 103, 300, 400 compartilham o mesmo grupo
            g = _sub(icms, "ICMSSN102")
            _sub(g, "orig", orig)
            _sub(g, "CSOSN", cst)
    else:
        if cst == "00":
            g = _sub(icms, "ICMS00")
            _sub(g, "orig", orig)
            _sub(g, "CST", cst)
            _sub(g, "modBC", "3")
            _sub(g, "vBC", fmt2(ln["icms_bc"]))
            _sub(g, "pICMS", fmt_aliq(parse_decimal(it.get("aliq_icms"), D(0))))
            _sub(g, "vICMS", fmt2(ln["icms_v"]))
        else:  # 40, 41, 50
            g = _sub(icms, "ICMS40")
            _sub(g, "orig", orig)
            _sub(g, "CST", cst)


def _grupo_pis_cofins(imposto, nome: str, ln: dict):
    cst = str(ln["it"].get(f"cst_{nome}"))
    raiz = _sub(imposto, nome.upper())
    n = nome.upper()
    if cst in ("01", "02"):
        g = _sub(raiz, f"{n}Aliq")
        _sub(g, "CST", cst)
        _sub(g, "vBC", fmt2(ln[f"{nome}_bc"]))
        _sub(g, f"p{n}", fmt_aliq(ln[f"{nome}_a"]))
        _sub(g, f"v{n}", fmt2(ln[f"{nome}_v"]))
    elif cst in ("04", "05", "06", "07", "08", "09"):
        g = _sub(raiz, f"{n}NT")
        _sub(g, "CST", cst)
    else:  # 49, 99 e demais "outras operações"
        g = _sub(raiz, f"{n}Outr")
        _sub(g, "CST", cst)
        _sub(g, "vBC", fmt2(ln[f"{nome}_bc"]))
        _sub(g, f"p{n}", fmt_aliq(ln[f"{nome}_a"]))
        _sub(g, f"v{n}", fmt2(ln[f"{nome}_v"]))


def construir_nfe(empresa: dict, cliente: dict, itens: list[dict], nota: dict, *,
                  numero: int, dh_emissao: datetime, cnf: str, tp_amb: str,
                  ver_proc: str = "NFeEmissor 1.0"):
    """Devolve (elemento NFe sem assinatura, chave de acesso, dict de cálculos)."""
    erros = validar_dados(empresa, cliente, itens, nota)
    if erros:
        raise DadosInvalidos(erros)

    crt = str(empresa["crt"])
    calc = calcular(empresa, cliente, itens, nota)
    linhas, tot = calc["linhas"], calc["totais"]

    uf_emit, uf_dest = empresa["uf"], cliente["uf"]
    cnpj = normalizar_cnpj(empresa["cnpj"])
    serie = int(nota.get("serie") or empresa.get("serie") or 1)
    chave = montar_chave(UF_CODIGO[uf_emit], dh_emissao.strftime("%y%m"), cnpj, "55",
                         serie, numero, 1, cnf)

    nfe = etree.Element(_tag("NFe"), nsmap={None: NS})
    inf = etree.SubElement(nfe, _tag("infNFe"), Id=f"NFe{chave}", versao=VERSAO)

    # ---- ide ----
    ide = _sub(inf, "ide")
    _sub(ide, "cUF", UF_CODIGO[uf_emit])
    _sub(ide, "cNF", cnf)
    _sub(ide, "natOp", limpar_texto(nota.get("nat_op") or "VENDA DE MERCADORIA", 60))
    _sub(ide, "mod", "55")
    _sub(ide, "serie", serie)
    _sub(ide, "nNF", numero)
    _sub(ide, "dhEmi", dh_emissao.isoformat(timespec="seconds"))
    _sub(ide, "tpNF", "1")
    _sub(ide, "idDest", "1" if uf_emit == uf_dest else "2")
    _sub(ide, "cMunFG", so_digitos(empresa["cod_municipio"]))
    _sub(ide, "tpImp", "1")
    _sub(ide, "tpEmis", "1")
    _sub(ide, "cDV", chave[-1])
    _sub(ide, "tpAmb", tp_amb)
    _sub(ide, "finNFe", "1")
    _sub(ide, "indFinal", str(nota.get("ind_final") or "1"))
    ind_pres = str(nota.get("ind_pres") or "2")
    _sub(ide, "indPres", ind_pres)
    if ind_pres in ("2", "3", "4", "9"):
        _sub(ide, "indIntermed", str(nota.get("ind_intermed") or "0"))
    _sub(ide, "procEmi", "0")
    _sub(ide, "verProc", ver_proc)

    # ---- emit ----
    emit = _sub(inf, "emit")
    _sub(emit, "CNPJ", cnpj)
    _sub(emit, "xNome", limpar_texto(empresa["razao_social"], 60))
    if limpar_texto(empresa.get("nome_fantasia")):
        _sub(emit, "xFant", limpar_texto(empresa["nome_fantasia"], 60))
    ee = _sub(emit, "enderEmit")
    _sub(ee, "xLgr", limpar_texto(empresa["logradouro"], 60))
    _sub(ee, "nro", limpar_texto(empresa["numero"], 60))
    if limpar_texto(empresa.get("complemento")):
        _sub(ee, "xCpl", limpar_texto(empresa["complemento"], 60))
    _sub(ee, "xBairro", limpar_texto(empresa["bairro"], 60))
    _sub(ee, "cMun", so_digitos(empresa["cod_municipio"]))
    _sub(ee, "xMun", limpar_texto(empresa["municipio"], 60))
    _sub(ee, "UF", uf_emit)
    _sub(ee, "CEP", so_digitos(empresa["cep"]))
    _sub(ee, "cPais", "1058")
    _sub(ee, "xPais", "BRASIL")
    if 6 <= len(so_digitos(empresa.get("fone"))) <= 14:
        _sub(ee, "fone", so_digitos(empresa["fone"]))
    _sub(emit, "IE", so_digitos(empresa["ie"]))
    if so_digitos(empresa.get("im")):
        _sub(emit, "IM", so_digitos(empresa["im"]))
        if so_digitos(empresa.get("cnae")):
            _sub(emit, "CNAE", so_digitos(empresa["cnae"]))
    _sub(emit, "CRT", crt)

    # ---- dest ----
    dest = _sub(inf, "dest")
    doc = normalizar_cnpj(cliente["documento"])
    _sub(dest, "CNPJ" if len(doc) == 14 else "CPF", doc)
    _sub(dest, "xNome", HOMOLOG_NOME if tp_amb == "2" else limpar_texto(cliente["nome"], 60))
    ed = _sub(dest, "enderDest")
    _sub(ed, "xLgr", limpar_texto(cliente["logradouro"], 60))
    _sub(ed, "nro", limpar_texto(cliente["numero"], 60))
    if limpar_texto(cliente.get("complemento")):
        _sub(ed, "xCpl", limpar_texto(cliente["complemento"], 60))
    _sub(ed, "xBairro", limpar_texto(cliente["bairro"], 60))
    _sub(ed, "cMun", so_digitos(cliente["cod_municipio"]))
    _sub(ed, "xMun", limpar_texto(cliente["municipio"], 60))
    _sub(ed, "UF", uf_dest)
    _sub(ed, "CEP", so_digitos(cliente["cep"]))
    _sub(ed, "cPais", "1058")
    _sub(ed, "xPais", "BRASIL")
    if 6 <= len(so_digitos(cliente.get("fone"))) <= 14:
        _sub(ed, "fone", so_digitos(cliente["fone"]))
    ind_ie = str(cliente.get("ind_ie_dest") or "9")
    _sub(dest, "indIEDest", ind_ie)
    if ind_ie == "1":
        _sub(dest, "IE", so_digitos(cliente["ie"]))
    if limpar_texto(cliente.get("email")):
        _sub(dest, "email", limpar_texto(cliente["email"], 60))

    # ---- det ----
    for n, ln in enumerate(linhas, start=1):
        it = ln["it"]
        det = etree.SubElement(inf, _tag("det"), nItem=str(n))
        prod = _sub(det, "prod")
        ean = so_digitos(it.get("ean")) or "SEM GTIN"
        _sub(prod, "cProd", limpar_texto(it["codigo"], 60))
        _sub(prod, "cEAN", ean)
        _sub(prod, "xProd", limpar_texto(it["descricao"], 120))
        _sub(prod, "NCM", so_digitos(it["ncm"]))
        if len(so_digitos(it.get("cest"))) == 7:
            _sub(prod, "CEST", so_digitos(it["cest"]))
            _sub(prod, "indEscala", "S")
        _sub(prod, "CFOP", ln["cfop"])
        un = limpar_texto(it.get("unidade") or "UN", 6) or "UN"
        _sub(prod, "uCom", un)
        _sub(prod, "qCom", fmt4(ln["qtd"]))
        _sub(prod, "vUnCom", fmt_unit(ln["vun"]))
        _sub(prod, "vProd", fmt2(ln["vprod"]))
        _sub(prod, "cEANTrib", ean)
        _sub(prod, "uTrib", un)
        _sub(prod, "qTrib", fmt4(ln["qtd"]))
        _sub(prod, "vUnTrib", fmt_unit(ln["vun"]))
        if ln["vfrete"] > 0:
            _sub(prod, "vFrete", fmt2(ln["vfrete"]))
        if ln["vdesc"] > 0:
            _sub(prod, "vDesc", fmt2(ln["vdesc"]))
        if ln["voutro"] > 0:
            _sub(prod, "vOutro", fmt2(ln["voutro"]))
        _sub(prod, "indTot", "1")
        imposto = _sub(det, "imposto")
        _grupo_icms(imposto, crt, ln)
        _grupo_pis_cofins(imposto, "pis", ln)
        _grupo_pis_cofins(imposto, "cofins", ln)

    # ---- total ----
    total = _sub(inf, "total")
    icmstot = _sub(total, "ICMSTot")
    for nome, valor in [("vBC", tot["vBC"]), ("vICMS", tot["vICMS"]), ("vICMSDeson", ZERO),
                        ("vFCP", ZERO), ("vBCST", ZERO), ("vST", ZERO), ("vFCPST", ZERO),
                        ("vFCPSTRet", ZERO), ("vProd", tot["vProd"]), ("vFrete", tot["vFrete"]),
                        ("vSeg", ZERO), ("vDesc", tot["vDesc"]), ("vII", ZERO), ("vIPI", ZERO),
                        ("vIPIDevol", ZERO), ("vPIS", tot["vPIS"]), ("vCOFINS", tot["vCOFINS"]),
                        ("vOutro", tot["vOutro"]), ("vNF", tot["vNF"])]:
        _sub(icmstot, nome, fmt2(valor))

    # ---- transp / pag ----
    transp = _sub(inf, "transp")
    _sub(transp, "modFrete", str(nota.get("mod_frete") or "9"))

    pag = _sub(inf, "pag")
    det_pag = _sub(pag, "detPag")
    t_pag = str(nota.get("forma_pagto") or "99")
    _sub(det_pag, "indPag", "0")
    _sub(det_pag, "tPag", t_pag)
    _sub(det_pag, "vPag", fmt2(ZERO if t_pag == "90" else tot["vNF"]))
    if t_pag in ("03", "04"):
        card = _sub(det_pag, "card")
        _sub(card, "tpIntegra", "2")

    # ---- intermediador (quando a venda é feita por marketplace) ----
    if str(nota.get("ind_intermed")) == "1" and ind_pres in ("2", "3", "4", "9"):
        inter = _sub(inf, "infIntermed")
        _sub(inter, "CNPJ", normalizar_cnpj(nota.get("intermed_cnpj")))
        _sub(inter, "idCadIntTran", limpar_texto(nota.get("intermed_id"), 60))

    # ---- informações adicionais ----
    partes = []
    if crt in ("1", "2"):
        partes.append("DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL")
        partes.append("NAO GERA DIREITO A CREDITO FISCAL DE IPI")
    partes.append(limpar_texto(nota.get("info_adicional")))
    if crt in ("1", "2"):
        partes.append(_texto_credito_sn(linhas))
    info = limpar_texto("; ".join(p for p in partes if p), 5000)
    if info:
        adic = _sub(inf, "infAdic")
        _sub(adic, "infCpl", info)

    # ---- responsável técnico (exigido por algumas UFs) ----
    rt = [empresa.get(k) for k in ("resp_tec_cnpj", "resp_tec_contato", "resp_tec_email",
                                   "resp_tec_fone")]
    if all(limpar_texto(x) for x in rt) and validar_cnpj(rt[0]):
        r = _sub(inf, "infRespTec")
        _sub(r, "CNPJ", normalizar_cnpj(rt[0]))
        _sub(r, "xContato", limpar_texto(rt[1], 60))
        _sub(r, "email", limpar_texto(rt[2], 60))
        _sub(r, "fone", so_digitos(rt[3]))

    return nfe, chave, calc


def serializar(elemento) -> str:
    """XML compacto (sem espaços/quebras entre tags e sem declaração)."""
    return etree.tostring(elemento, encoding="unicode")

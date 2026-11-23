"""Geração do DANFE (PDF, retrato A4) a partir do XML da NF-e.

O DANFE é só a representação impressa. O documento fiscal válido é o XML autorizado.
"""
import io
from datetime import datetime
from decimal import Decimal

from lxml import etree
from reportlab.graphics.barcode import code128
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.utils import simpleSplit
from reportlab.pdfgen import canvas

NS = "http://www.portalfiscal.inf.br/nfe"
LARGURA, ALTURA = A4
MARGEM = 8 * mm
UTIL = LARGURA - 2 * MARGEM  # 194 mm

MOD_FRETE = {"0": "0 - Remetente (CIF)", "1": "1 - Destinatário (FOB)", "2": "2 - Terceiros",
             "3": "3 - Próprio, remetente", "4": "4 - Próprio, destinatário",
             "9": "9 - Sem transporte"}


def _f(el, caminho: str):
    atual = el
    for parte in caminho.split("/"):
        if atual is None:
            return None
        atual = atual.find(f"{{{NS}}}{parte}")
    return atual


def _g(el, caminho: str) -> str:
    f = _f(el, caminho)
    return f.text if f is not None and f.text else ""


def br(valor, casas: int = 2) -> str:
    if valor in (None, ""):
        return ""
    s = f"{Decimal(str(valor)):,.{casas}f}"
    return s.replace(",", "X").replace(".", ",").replace("X", ".")


def fmt_doc(doc: str) -> str:
    if len(doc) == 11:
        return f"{doc[:3]}.{doc[3:6]}.{doc[6:9]}-{doc[9:]}"
    if len(doc) == 14 and doc.isdigit():
        return f"{doc[:2]}.{doc[2:5]}.{doc[5:8]}/{doc[8:12]}-{doc[12:]}"
    return doc


def fmt_data(iso: str, com_hora=True) -> str:
    if not iso:
        return ""
    try:
        d = datetime.fromisoformat(iso)
    except ValueError:
        return iso
    return d.strftime("%d/%m/%Y %H:%M:%S" if com_hora else "%d/%m/%Y")


class _Desenho:
    def __init__(self, xml: str | bytes, cancelada: bool = False):
        if isinstance(xml, str):
            xml = xml.encode("utf-8")
        raiz = etree.fromstring(xml)
        tag = etree.QName(raiz).localname
        self.nfe = raiz if tag == "NFe" else raiz.find(f"{{{NS}}}NFe")
        self.prot = raiz.find(f"{{{NS}}}protNFe") if tag == "nfeProc" else None
        self.inf = self.nfe.find(f"{{{NS}}}infNFe")
        self.chave = self.inf.get("Id", "")[3:]
        self.homolog = _g(self.inf, "ide/tpAmb") == "2"
        self.cancelada = cancelada
        self.itens = self.inf.findall(f"{{{NS}}}det")
        self.buf = io.BytesIO()
        self.c = canvas.Canvas(self.buf, pagesize=A4)
        self.c.setTitle(f"DANFE {self.chave}")
        self.pagina = 0
        self.total_paginas = 1

    # --- primitivas (y sempre medido do TOPO da página, em mm) ---
    def y(self, topo_mm: float) -> float:
        return ALTURA - topo_mm * mm

    def caixa(self, x, topo, w, h, rotulo="", valor="", fonte=8.5, negrito=False, alinhar="l"):
        c = self.c
        c.setLineWidth(0.4)
        c.rect(x * mm, self.y(topo + h), w * mm, h * mm)
        if rotulo:
            c.setFont("Helvetica", 5.5)
            c.drawString((x + 1) * mm, self.y(topo + 2.6), rotulo.upper())
        if valor != "":
            c.setFont("Helvetica-Bold" if negrito else "Helvetica", fonte)
            ty = self.y(topo + h - 1.8)
            if alinhar == "r":
                c.drawRightString((x + w - 1) * mm, ty, str(valor))
            elif alinhar == "c":
                c.drawCentredString((x + w / 2) * mm, ty, str(valor))
            else:
                c.drawString((x + 1) * mm, ty, str(valor))

    def titulo(self, topo, texto):
        self.c.setFont("Helvetica-Bold", 7)
        self.c.drawString(MARGEM, self.y(topo + 2.2), texto.upper())

    def marca_dagua(self):
        textos = []
        if self.cancelada:
            textos.append("CANCELADA")
        if self.prot is None:
            textos.append("NF-e NÃO AUTORIZADA")
        if self.homolog:
            textos.append("SEM VALOR FISCAL")
        if not textos:
            return
        c = self.c
        c.saveState()
        c.setFillGray(0.86)
        c.translate(LARGURA / 2, ALTURA / 2)
        c.rotate(45)
        for i, t in enumerate(textos):
            c.setFont("Helvetica-Bold", 46 if len(t) < 14 else 34)
            c.drawCentredString(0, -i * 18 * mm, t)
        c.restoreState()

    # --- blocos ---
    def cabecalho(self):
        x0 = MARGEM / mm
        topo = 8
        i = self.inf
        c = self.c
        # emitente
        self.caixa(x0, topo, 82, 32)
        c.setFont("Helvetica-Bold", 10)
        nome = _g(i, "emit/xNome")
        for n, linha in enumerate(simpleSplit(nome, "Helvetica-Bold", 10, 78 * mm)[:3]):
            c.drawString((x0 + 2) * mm, self.y(topo + 7 + n * 4.2), linha)
        c.setFont("Helvetica", 7)
        e = _f(i, "emit/enderEmit")
        l1 = f"{_g(e, 'xLgr')}, {_g(e, 'nro')} {_g(e, 'xCpl')}".strip()
        l2 = f"{_g(e, 'xBairro')} - CEP {_g(e, 'CEP')}"
        l3 = f"{_g(e, 'xMun')} - {_g(e, 'UF')}   Fone: {_g(e, 'fone')}"
        for n, linha in enumerate((l1, l2, l3)):
            c.drawString((x0 + 2) * mm, self.y(topo + 20 + n * 3.8), linha[:62])
        # DANFE
        xd = x0 + 82
        self.caixa(xd, topo, 34, 32)
        c.setFont("Helvetica-Bold", 14)
        c.drawCentredString((xd + 17) * mm, self.y(topo + 7), "DANFE")
        c.setFont("Helvetica", 5.5)
        c.drawCentredString((xd + 17) * mm, self.y(topo + 10.5), "Documento Auxiliar da")
        c.drawCentredString((xd + 17) * mm, self.y(topo + 12.5), "Nota Fiscal Eletrônica")
        c.setFont("Helvetica", 6.5)
        c.drawString((xd + 3) * mm, self.y(topo + 17), "0 - ENTRADA")
        c.drawString((xd + 3) * mm, self.y(topo + 20), "1 - SAÍDA")
        c.rect((xd + 24) * mm, self.y(topo + 21), 6 * mm, 6 * mm)
        c.setFont("Helvetica-Bold", 9)
        c.drawCentredString((xd + 27) * mm, self.y(topo + 19.8), _g(i, "ide/tpNF") or "1")
        num = int(_g(i, "ide/nNF") or 0)
        c.setFont("Helvetica-Bold", 8)
        c.drawCentredString((xd + 17) * mm, self.y(topo + 25), f"Nº {num:,}".replace(",", "."))
        c.drawCentredString((xd + 17) * mm, self.y(topo + 28), f"SÉRIE {_g(i, 'ide/serie')}")
        c.setFont("Helvetica", 6)
        c.drawCentredString((xd + 17) * mm, self.y(topo + 31), f"Folha {self.pagina}/{self.total_paginas}")
        # chave
        xc = xd + 34
        self.caixa(xc, topo, 78, 32)
        barra = code128.Code128(self.chave, barHeight=11 * mm, barWidth=0.3 * mm, quiet=False)
        alvo = 72 * mm
        barra = code128.Code128(self.chave, barHeight=11 * mm,
                                barWidth=0.3 * mm * alvo / barra.width, quiet=False)
        barra.drawOn(c, (xc + 3) * mm, self.y(topo + 14))
        c.setFont("Helvetica", 5.5)
        c.drawString((xc + 1) * mm, self.y(topo + 17), "CHAVE DE ACESSO")
        c.setFont("Helvetica-Bold", 7)
        grupos = " ".join(self.chave[k:k + 4] for k in range(0, 44, 4))
        c.drawCentredString((xc + 39) * mm, self.y(topo + 21), grupos)
        c.setFont("Helvetica", 5.5)
        c.drawCentredString((xc + 39) * mm, self.y(topo + 25.5), "Consulta de autenticidade no portal nacional da NF-e")
        c.drawCentredString((xc + 39) * mm, self.y(topo + 28), "www.nfe.fazenda.gov.br/portal ou no site da SEFAZ autorizadora")

        # natureza / protocolo
        t2 = topo + 32
        self.caixa(x0, t2, 116, 10, "Natureza da operação", _g(i, "ide/natOp"))
        if self.prot is not None:
            prot = f"{_g(self.prot, 'infProt/nProt')} - {fmt_data(_g(self.prot, 'infProt/dhRecbto'))}"
        else:
            prot = "NF-e sem protocolo de autorização"
        self.caixa(x0 + 116, t2, 78, 10, "Protocolo de autorização de uso", prot, fonte=7.5)
        t3 = t2 + 10
        self.caixa(x0, t3, 70, 10, "Inscrição estadual", _g(i, "emit/IE"))
        self.caixa(x0 + 70, t3, 54, 10, "Inscrição municipal", _g(i, "emit/IM"))
        self.caixa(x0 + 124, t3, 70, 10, "CNPJ", fmt_doc(_g(i, "emit/CNPJ")))
        return t3 + 10

    def destinatario(self, topo):
        x0, i = MARGEM / mm, self.inf
        self.titulo(topo, "Destinatário / Remetente")
        t = topo + 3
        doc = _g(i, "dest/CNPJ") or _g(i, "dest/CPF")
        self.caixa(x0, t, 112, 9, "Nome / Razão social", _g(i, "dest/xNome"), fonte=7.5)
        self.caixa(x0 + 112, t, 42, 9, "CNPJ / CPF", fmt_doc(doc))
        self.caixa(x0 + 154, t, 40, 9, "Data da emissão", fmt_data(_g(i, "ide/dhEmi"), False))
        t += 9
        d = _f(i, "dest/enderDest")
        self.caixa(x0, t, 90, 9, "Endereço", f"{_g(d, 'xLgr')}, {_g(d, 'nro')} {_g(d, 'xCpl')}".strip(), fonte=7.5)
        self.caixa(x0 + 90, t, 54, 9, "Bairro / Distrito", _g(d, "xBairro"), fonte=7.5)
        self.caixa(x0 + 144, t, 50, 9, "CEP", _g(d, "CEP"))
        t += 9
        self.caixa(x0, t, 80, 9, "Município", _g(d, "xMun"), fonte=7.5)
        self.caixa(x0 + 80, t, 40, 9, "Fone / Fax", _g(d, "fone"))
        self.caixa(x0 + 120, t, 14, 9, "UF", _g(d, "UF"))
        self.caixa(x0 + 134, t, 60, 9, "Inscrição estadual", _g(i, "dest/IE"))
        return t + 9

    def impostos(self, topo):
        x0, tot = MARGEM / mm, _f(self.inf, "total/ICMSTot")
        self.titulo(topo, "Cálculo do imposto")
        t = topo + 3
        w = 194 / 5
        for k, (rot, tag) in enumerate([("Base de cálc. do ICMS", "vBC"), ("Valor do ICMS", "vICMS"),
                                       ("Base de cálc. ICMS ST", "vBCST"), ("Valor do ICMS ST", "vST"),
                                       ("Valor total dos produtos", "vProd")]):
            self.caixa(x0 + k * w, t, w, 9, rot, br(_g(tot, tag)), alinhar="r")
        t += 9
        for k, (rot, tag, neg) in enumerate([("Valor do frete", "vFrete", False), ("Valor do seguro", "vSeg", False),
                                             ("Desconto", "vDesc", False), ("Outras desp. acessórias", "vOutro", False),
                                             ("Valor total da nota", "vNF", True)]):
            self.caixa(x0 + k * w, t, w, 9, rot, br(_g(tot, tag)), negrito=neg, alinhar="r")
        return t + 9

    def transporte(self, topo):
        x0 = MARGEM / mm
        self.titulo(topo, "Transportador / Volumes transportados")
        t = topo + 3
        self.caixa(x0, t, 194, 9, "Frete por conta", MOD_FRETE.get(_g(self.inf, "transp/modFrete"), ""))
        return t + 9

    # --- itens ---
    COLS = [("Código", 18), ("Descrição do produto / serviço", 56), ("NCM", 15), ("O/CST", 9),
            ("CFOP", 10), ("UN", 8), ("Quant.", 14), ("Vl. unit.", 16), ("Vl. total", 17),
            ("BC ICMS", 12), ("Vl. ICMS", 10), ("Alíq.", 9)]

    def cabecalho_itens(self, topo):
        x = MARGEM / mm
        self.c.setFont("Helvetica-Bold", 7)
        self.c.drawString(MARGEM, self.y(topo + 2.2), "DADOS DOS PRODUTOS / SERVIÇOS")
        t = topo + 3
        for nome, w in self.COLS:
            self.caixa(x, t, w, 6)
            self.c.setFont("Helvetica-Bold", 5.5)
            self.c.drawCentredString((x + w / 2) * mm, self.y(t + 3.8), nome.upper() if len(nome) < 12 else "DESCRIÇÃO DO PRODUTO")
            x += w
        return t + 6

    def linhas_item(self, det):
        prod = _f(det, "prod")
        imposto = _f(det, "imposto/ICMS")
        grupo = imposto[0] if imposto is not None and len(imposto) else None
        cst = _g(grupo, "orig") + (_g(grupo, "CST") or _g(grupo, "CSOSN"))
        desc = simpleSplit(_g(prod, "xProd"), "Helvetica", 6.5, 54 * mm) or [""]
        return {
            "cod": _g(prod, "cProd")[:14], "desc": desc, "ncm": _g(prod, "NCM"), "cst": cst,
            "cfop": _g(prod, "CFOP"), "un": _g(prod, "uCom"), "qtd": br(_g(prod, "qCom"), 4),
            "vun": br(_g(prod, "vUnCom"), 2), "vtot": br(_g(prod, "vProd")),
            "bc": br(_g(grupo, "vBC")) if _g(grupo, "vBC") else "0,00",
            "vicms": br(_g(grupo, "vICMS")) if _g(grupo, "vICMS") else "0,00",
            "aliq": br(_g(grupo, "pICMS")) if _g(grupo, "pICMS") else "0,00",
            "h": max(5.5, len(desc) * 2.7 + 1.8),
        }

    def desenhar_item(self, topo, d):
        x, h = MARGEM / mm, d["h"]
        valores = [d["cod"], None, d["ncm"], d["cst"], d["cfop"], d["un"], d["qtd"], d["vun"],
                   d["vtot"], d["bc"], d["vicms"], d["aliq"]]
        for (nome, w), val in zip(self.COLS, valores):
            self.caixa(x, topo, w, h)
            self.c.setFont("Helvetica", 6.5)
            if val is None:
                for n, linha in enumerate(d["desc"]):
                    self.c.drawString((x + 1) * mm, self.y(topo + 3 + n * 2.7), linha)
            elif nome in ("Quant.", "Vl. unit.", "Vl. total", "BC ICMS", "Vl. ICMS", "Alíq."):
                self.c.drawRightString((x + w - 1) * mm, self.y(topo + 3), val)
            else:
                self.c.drawString((x + 1) * mm, self.y(topo + 3), val)
            x += w

    def dados_adicionais(self, topo):
        x0 = MARGEM / mm
        self.titulo(topo, "Dados adicionais")
        info = _g(self.inf, "infAdic/infCpl")
        linhas = simpleSplit(info, "Helvetica", 7, 190 * mm) if info else []
        if self.homolog:
            linhas.insert(0, "AMBIENTE DE HOMOLOGAÇÃO - SEM VALOR FISCAL")
        altura = max(20, len(linhas) * 3.2 + 4)
        self.caixa(x0, topo + 3, 194, altura, "Informações complementares")
        self.c.setFont("Helvetica", 7)
        for n, linha in enumerate(linhas):
            self.c.drawString((x0 + 1) * mm, self.y(topo + 8 + n * 3.2), linha)
        return topo + 3 + altura

    # --- orquestração ---
    def gerar(self) -> bytes:
        dados = [self.linhas_item(d) for d in self.itens]
        # 1ª passada: paginação
        fim = 285
        paginas, atual, ocupado = [], [], 0.0
        topo_p1 = None  # definido ao desenhar; estimativa conservadora: 152 mm
        limite = [fim - 152, fim - 22]  # espaço p/ itens na 1ª página e nas seguintes
        for d in dados:
            disponivel = limite[0 if not paginas else 1]
            if ocupado + d["h"] > disponivel and atual:
                paginas.append(atual)
                atual, ocupado = [], 0.0
            atual.append(d)
            ocupado += d["h"]
        paginas.append(atual)
        # espaço para "dados adicionais" na última página
        info = _g(self.inf, "infAdic/infCpl")
        precisa = 12 + (len(simpleSplit(info, "Helvetica", 7, 190 * mm)) * 3.2 + 4 if info else 24)
        disponivel_ultima = limite[0 if len(paginas) == 1 else 1] - sum(d["h"] for d in paginas[-1])
        if disponivel_ultima < precisa:
            paginas.append([])
        self.total_paginas = len(paginas)

        for n, pagina in enumerate(paginas, start=1):
            self.pagina = n
            self.marca_dagua()
            if n == 1:
                topo = self.cabecalho()
                topo = self.destinatario(topo + 1)
                topo = self.impostos(topo + 1)
                topo = self.transporte(topo + 1)
                topo += 1
            else:
                self.c.setFont("Helvetica", 7)
                self.c.drawString(MARGEM, self.y(12),
                                  f"DANFE - NF-e Nº {_g(self.inf, 'ide/nNF')} Série {_g(self.inf, 'ide/serie')}"
                                  f"   Chave: {self.chave}   Folha {n}/{self.total_paginas}")
                topo = 16
            topo = self.cabecalho_itens(topo)
            for d in pagina:
                self.desenhar_item(topo, d)
                topo += d["h"]
            if n == len(paginas):
                self.dados_adicionais(topo + 3)
            self.c.showPage()
        self.c.save()
        return self.buf.getvalue()


def gerar_danfe(xml: str | bytes, cancelada: bool = False) -> bytes:
    return _Desenho(xml, cancelada).gerar()

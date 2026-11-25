"""Importação em lote de clientes e produtos por planilha (CSV ou Excel .xlsx).

Fluxo: ler_registros() abre o arquivo e mapeia as colunas pelo nome do cabeçalho (aceita variações
como "CPF/CNPJ", "Cidade", "SKU"); aplicar() valida linha a linha com as MESMAS regras do cadastro
manual e grava. Linha com dado faltando/inválido NÃO é descartada: é salva como cadastro INCOMPLETO
(pendente), com a lista do que falta, para o usuário completar depois na tela de edição. Só não é salva
a linha que não dá para identificar (produto sem código e sem descrição; cliente sem CPF/CNPJ e sem nome).

Quem já existe (produto: mesmo código; cliente: mesmo CPF/CNPJ) é atualizado ou pulado, conforme
a escolha do usuário. Na atualização, só mudam as colunas presentes na planilha e com valor
preenchido: célula vazia nunca apaga o que já está cadastrado.
"""
import csv
import hashlib
import io
import re
import time
import unicodedata
import zipfile
from dataclasses import dataclass, field

from .nfe import tabelas as T
from .nfe.util import limpar_texto, normalizar_cnpj, parse_decimal, so_digitos, validar_documento

MAX_LINHAS = 5000
TAMANHO_MAX = 5 * 1024 * 1024
MAX_CONSULTAS_CEP = 150
TEMPO_MAX_CEP = 20.0           # segundos, somando todas as consultas de CEP de uma importação

CAMPOS_PRODUTO = [
    # campo, rótulo, obrigatório, dica
    ("codigo", "Código (SKU)", True, "Identifica o produto. Se já existir, é atualizado."),
    ("descricao", "Descrição", True, "Até 120 caracteres."),
    ("ncm", "NCM", True, "8 dígitos."),
    ("preco", "Preço", False, "Ex.: 49,90"),
    ("unidade", "Unidade", False, "UN, KG, PC... (padrão UN)"),
    ("cfop", "CFOP", False, "4 dígitos (padrão 5102)"),
    ("cst_icms", "CSOSN/CST ICMS", False, "Simples: 101, 102, 103, 300, 400. Regime normal: 00, 40, 41, 50."),
    ("aliq_icms", "Alíquota ICMS %", False, "Padrão 0"),
    ("origem", "Origem", False, "0 a 8 (padrão 0 = nacional)"),
    ("cest", "CEST", False, "7 dígitos, se houver"),
    ("ean", "GTIN/EAN", False, "8, 12, 13 ou 14 dígitos, se houver"),
    ("cst_pis", "CST PIS", False, "Padrão 49"),
    ("aliq_pis", "Alíquota PIS %", False, "Padrão 0"),
    ("cst_cofins", "CST COFINS", False, "Padrão 49"),
    ("aliq_cofins", "Alíquota COFINS %", False, "Padrão 0"),
]

CAMPOS_CLIENTE = [
    ("documento", "CPF/CNPJ", True, "Identifica o cliente. Se já existir, é atualizado."),
    ("nome", "Nome / Razão social", True, "Até 60 caracteres."),
    ("cep", "CEP", True, "8 dígitos."),
    ("logradouro", "Logradouro", False, "Se vazio, é buscado pelo CEP."),
    ("numero", "Número", True, "Use S/N se não houver."),
    ("bairro", "Bairro", False, "Se vazio, é buscado pelo CEP."),
    ("municipio", "Município", False, "Se vazio, é preenchido pelo CEP."),
    ("uf", "UF", False, "Se vazia, é preenchida pelo CEP."),
    ("cod_municipio", "Código IBGE do município", False, "7 dígitos. Se vazio, é buscado pelo CEP."),
    ("complemento", "Complemento", False, ""),
    ("ind_ie_dest", "Contribuinte ICMS", False, "1 = contribuinte, 2 = isento, 9 = não contribuinte (padrão 9)."),
    ("ie", "Inscrição estadual", False, "Obrigatória para contribuinte (1)."),
    ("email", "E-mail", False, ""),
    ("fone", "Telefone", False, ""),
]

_ALIASES_PRODUTO = {
    "codigo": ["codigo", "cod", "sku", "codigo_sku", "referencia", "ref", "codigo_do_produto", "cod_produto", "codigo_interno", "id", "item"],
    "descricao": ["descricao", "nome", "produto", "descricao_do_produto", "titulo", "nome_do_produto"],
    "ncm": ["ncm", "codigo_ncm", "ncm_sh", "classificacao_fiscal"],
    "preco": ["preco", "valor", "preco_venda", "preco_de_venda", "valor_unitario", "valor_venda", "preco_unitario", "vlr", "vl_unitario", "preco_r", "valor_r"],
    "unidade": ["unidade", "un", "und", "unid", "unidade_de_medida", "medida"],
    "cfop": ["cfop"],
    "cst_icms": ["cst_icms", "csosn", "cst", "cst_csosn", "csosn_cst", "icms_cst", "csosn_icms", "cst_ou_csosn"],
    "aliq_icms": ["aliq_icms", "aliquota_icms", "icms", "p_icms", "icms_aliquota", "aliq_icms_percent"],
    "origem": ["origem", "origem_mercadoria", "orig"],
    "cest": ["cest"],
    "ean": ["ean", "gtin", "codigo_de_barras", "cod_barras", "ean_gtin", "gtin_ean"],
    "cst_pis": ["cst_pis", "pis_cst", "cst_do_pis"],
    "aliq_pis": ["aliq_pis", "aliquota_pis", "pis", "p_pis"],
    "cst_cofins": ["cst_cofins", "cofins_cst", "cst_do_cofins"],
    "aliq_cofins": ["aliq_cofins", "aliquota_cofins", "cofins", "p_cofins"],
}
_ALIASES_CLIENTE = {
    "documento": ["documento", "cpf_cnpj", "cnpj_cpf", "cpf", "cnpj", "cpfcnpj", "cnpjcpf", "doc", "cpf_ou_cnpj", "cpf_cnpj_do_cliente", "documento_cliente"],
    "nome": ["nome", "razao_social", "cliente", "nome_razao_social", "nome_cliente", "razao_social_nome",
             "nome_completo", "comprador", "destinatario"],
    "cep": ["cep"],
    "logradouro": ["logradouro", "endereco", "rua", "avenida", "end"],
    "numero": ["numero", "num", "n", "nro", "numero_endereco"],
    "bairro": ["bairro"],
    "municipio": ["municipio", "cidade", "localidade"],
    "uf": ["uf", "estado", "sigla_uf"],
    "cod_municipio": ["cod_municipio", "codigo_municipio", "codigo_ibge", "ibge", "cod_ibge", "municipio_ibge",
                      "codigo_do_municipio"],
    "complemento": ["complemento", "compl"],
    "ind_ie_dest": ["ind_ie_dest", "contribuinte", "indicador_ie", "ind_ie", "contribuinte_icms",
                    "indicador_de_ie"],
    "ie": ["ie", "inscricao_estadual", "insc_estadual", "inscricao_est"],
    "email": ["email", "e_mail"],
    "fone": ["fone", "telefone", "celular", "whatsapp", "tel", "telefone_celular", "contato"],
}
_TIPOS = {
    "produto": (CAMPOS_PRODUTO, _ALIASES_PRODUTO),
    "cliente": (CAMPOS_CLIENTE, _ALIASES_CLIENTE),
}


# Para o cabeçalho ser aceito basta UMA destas colunas (cada tipo precisa conseguir identificar a linha)
_IDENTIFICADOR = {"produto": ("codigo", "descricao"), "cliente": ("documento", "nome")}


class ArquivoInvalido(ValueError):
    """Problema no arquivo como um todo (mensagem pronta para o usuário)."""


@dataclass
class Resultado:
    tipo: str
    total: int = 0
    criados: int = 0
    atualizados: int = 0
    ignorados: int = 0
    erros: list = field(default_factory=list)          # linhas NÃO salvas: [(linha, [mensagens])]
    incompletos: list = field(default_factory=list)    # linhas salvas como pendentes: [(linha, [o que falta])]
    ressalvas: list = field(default_factory=list)      # cadastro existente mantido: [(linha, [valores ignorados])]
    pendentes: int = 0
    codigos_automaticos: int = 0
    colunas_ignoradas: list = field(default_factory=list)
    avisos: list = field(default_factory=list)
    simulado: bool = False

    @property
    def com_erro(self) -> int:
        return len(self.erros)


# ------------------------------------------------------------------------------ leitura
def _chave(texto) -> str:
    s = unicodedata.normalize("NFKD", str(texto or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "_", s).strip("_")


def _valor(v) -> str:
    """Célula (CSV ou Excel) -> texto limpo."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else repr(v)
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return str(v).replace("\xa0", " ").strip()


def _linhas_csv(dados: bytes):
    texto = None
    for codificacao in ("utf-8-sig", "cp1252"):
        try:
            texto = dados.decode(codificacao)
            break
        except UnicodeDecodeError:
            continue
    if texto is None:
        texto = dados.decode("latin-1")
    primeira = next((ln for ln in texto.splitlines() if ln.strip()), "")
    delim = max((";", ",", "\t"), key=primeira.count)
    leitor = csv.reader(io.StringIO(texto), delimiter=delim)
    try:
        for n, linha in enumerate(leitor, start=1):
            yield n, [_valor(c) for c in linha]
    except csv.Error as exc:
        raise ArquivoInvalido(f"Não consegui ler o CSV: {exc}") from None


def _linhas_xlsx(dados: bytes):
    try:
        with zipfile.ZipFile(io.BytesIO(dados)) as z:
            if sum(i.file_size for i in z.infolist()) > 150 * 1024 * 1024 or len(z.infolist()) > 500:
                raise ArquivoInvalido("A planilha é grande demais ou está malformada.")
    except zipfile.BadZipFile:
        raise ArquivoInvalido("Não consegui abrir a planilha. Salve como .xlsx (Pasta de Trabalho do Excel) "
                              "ou como CSV e tente de novo.") from None
    from openpyxl import load_workbook
    try:
        wb = load_workbook(io.BytesIO(dados), read_only=True, data_only=True)
    except Exception:
        raise ArquivoInvalido("Não consegui abrir a planilha. Salve como .xlsx ou como CSV e tente de novo.") from None
    try:
        for ws in wb.worksheets:
            if getattr(ws, "iter_rows", None) is None:      # aba de gráfico
                continue
            achou = False
            for n, linha in enumerate(ws.iter_rows(values_only=True), start=1):
                celulas = [_valor(c) for c in linha]
                if any(celulas):
                    achou = True
                yield n, celulas
                if n > MAX_LINHAS + 200:
                    return
            if achou:
                return
    finally:
        wb.close()


def ler_registros(tipo: str, nome_arquivo: str, dados: bytes):
    """Devolve ([(numero_da_linha, {campo: texto})], colunas_ignoradas)."""
    campos, aliases = _TIPOS[tipo]
    if not dados:
        raise ArquivoInvalido("O arquivo está vazio.")
    if len(dados) > TAMANHO_MAX:
        raise ArquivoInvalido("Arquivo grande demais: o máximo é 5 MB.")
    nome = (nome_arquivo or "").lower()
    if dados[:2] == b"PK" or nome.endswith((".xlsx", ".xlsm")):
        linhas = _linhas_xlsx(dados)
    elif nome.endswith(".xls") or dados[:4] == b"\xd0\xcf\x11\xe0":
        raise ArquivoInvalido("Arquivo .xls (Excel antigo) não é aceito. No Excel use Salvar como → "
                              "Pasta de Trabalho do Excel (.xlsx) ou CSV.")
    else:
        linhas = _linhas_csv(dados)

    mapa, ignoradas, cabecalho_em = {}, [], None
    registros, vistas = [], []
    por_alias = {_chave(a): campo for campo, lista in aliases.items() for a in lista}
    por_alias.update({_chave(rot): campo for campo, rot, *_ in campos})
    ident = _IDENTIFICADOR[tipo]
    for n, celulas in linhas:
        if cabecalho_em is None:
            if not any(celulas):
                continue
            # o cabeçalho pode não ser a 1ª linha (títulos, logotipo, linhas em branco): procura nas 15 primeiras
            achados, ign = {}, []
            for i, titulo in enumerate(celulas):
                if not titulo:
                    continue
                campo = por_alias.get(_chave(titulo))
                if campo and campo not in achados:
                    achados[campo] = i
                else:
                    ign.append(titulo)
            if any(c in achados for c in ident):
                cabecalho_em, mapa, ignoradas = n, achados, ign
                continue
            vistas.append(celulas)
            if len(vistas) >= 15:
                break
            continue
        if not any(celulas):
            continue
        registros.append((n, {c: (celulas[i] if i < len(celulas) else "") for c, i in mapa.items()}))
        if len(registros) > MAX_LINHAS:
            raise ArquivoInvalido(f"Arquivo com mais de {MAX_LINHAS} linhas. Divida em partes menores.")
    if cabecalho_em is None and vistas:
        rotulos = " ou ".join(next(rot for c, rot, *_ in campos if c == i) for i in ident)
        raise ArquivoInvalido(
            f"Não encontrei no cabeçalho a coluna de identificação: {rotulos}. "
            "Baixe o modelo de planilha e use os mesmos nomes de coluna.")
    if cabecalho_em is None:
        raise ArquivoInvalido("Não encontrei nenhum dado no arquivo.")
    if not registros:
        raise ArquivoInvalido("O arquivo tem só o cabeçalho, sem nenhuma linha de dados.")
    return registros, ignoradas


# ------------------------------------------------------------------------------ validação
_NOTACAO = re.compile(r"^[\d.,]+[eE][+\-]?\d+$")


def _digitos(bruto: str, rotulo: str, erros: list, zeros: int = 0) -> str:
    """Só dígitos; devolve os zeros à esquerda que o Excel costuma comer (NCM, CEP...)."""
    if _NOTACAO.match(bruto or ""):
        erros.append(f"{rotulo}: o Excel converteu o número para notação científica ({bruto}). "
                     "Formate a coluna como Texto e digite de novo.")
        return ""
    d = so_digitos(bruto)
    if zeros and d and len(d) < zeros:
        d = d.zfill(zeros)
    return d


def _decimal(bruto: str, rotulo: str, erros: list, padrao: str = "0") -> str:
    bruto = re.sub(r"(?i)r\$|%|\s", "", bruto or "")          # "R$ 49,90", "18 %"
    try:
        v = parse_decimal(bruto or padrao)
        if v < 0:
            erros.append(f"{rotulo}: não pode ser negativo.")
        return format(v, "f")
    except ValueError:
        erros.append(f"{rotulo}: número inválido ({bruto}).")
        return padrao


_UNIDADES = {"UNIDADE": "UN", "UNID": "UN", "UND": "UN", "UNIDADES": "UN", "PECA": "PC", "PEÇA": "PC",
             "PECAS": "PC", "PEÇAS": "PC", "QUILO": "KG", "QUILOS": "KG", "LITRO": "L", "LITROS": "L",
             "CAIXA": "CX", "PACOTE": "PCT", "METRO": "M", "METROS": "M", "PAR": "PAR", "PARES": "PAR"}
_ORIGENS = {"NACIONAL": "0", "IMPORTADO": "1", "ESTRANGEIRA": "1"}


def padrao_produto(crt: str) -> dict:
    return {"codigo": "", "descricao": "", "ncm": "", "cest": "", "ean": "", "unidade": "UN", "preco": "0.00",
            "origem": "0", "cfop": "5102", "cst_icms": "102" if crt in ("1", "2") else "00", "aliq_icms": "0",
            "cst_pis": "49", "aliq_pis": "0", "cst_cofins": "49", "aliq_cofins": "0"}


def validar_produto(m: dict, crt: str):
    """m: valores em texto já mesclados com os padrões. Devolve (dict pronto p/ gravar, erros)."""
    erros = []
    d = {
        "codigo": limpar_texto(m["codigo"], 60), "descricao": limpar_texto(m["descricao"], 120),
        "ncm": _digitos(m["ncm"], "NCM", erros, 8), "cest": _digitos(m["cest"], "CEST", erros, 7),
        "unidade": _UNIDADES.get(limpar_texto(m["unidade"], 20).upper(), limpar_texto(m["unidade"], 6).upper()) or "UN",
        "origem": _digitos(_ORIGENS.get((m["origem"] or "").strip().upper(), m["origem"]), "Origem", erros) or "0",
        "cfop": _digitos(m["cfop"], "CFOP", erros),
        "cst_icms": so_digitos(m["cst_icms"]), "cst_pis": so_digitos(m["cst_pis"]) or "49",
        "cst_cofins": so_digitos(m["cst_cofins"]) or "49",
    }
    ean = _digitos(m["ean"], "GTIN/EAN", erros)
    d["ean"] = ean.zfill({7: 8, 11: 12}[len(ean)]) if len(ean) in (7, 11) else ean
    d["preco"] = _decimal(m["preco"], "Preço", erros, "0.00")
    d["aliq_icms"] = _decimal(m["aliq_icms"], "Alíquota ICMS", erros)
    d["aliq_pis"] = _decimal(m["aliq_pis"], "Alíquota PIS", erros)
    d["aliq_cofins"] = _decimal(m["aliq_cofins"], "Alíquota COFINS", erros)
    if not d["codigo"]:
        erros.append("Informe o código (SKU).")
    if not d["descricao"]:
        erros.append("Informe a descrição.")
    if len(d["ncm"]) != 8:
        erros.append("NCM deve ter 8 dígitos.")
    if d["cest"] and len(d["cest"]) != 7:
        erros.append("CEST deve ter 7 dígitos (ou ficar vazio).")
    if d["ean"] and len(d["ean"]) not in (8, 12, 13, 14):
        erros.append("GTIN/EAN deve ter 8, 12, 13 ou 14 dígitos (ou ficar vazio).")
    if len(d["cfop"]) != 4:
        erros.append("CFOP deve ter 4 dígitos.")
    if d["origem"] not in tuple("012345678"):
        erros.append("Origem deve ser um número de 0 a 8.")
    validos = [c for c, _ in (T.ICMS_SIMPLES if crt in ("1", "2") else T.ICMS_NORMAL)]
    if d["cst_icms"] not in validos:                      # o Excel come o zero: 0 -> "00", 40 ok
        d["cst_icms"] = next((d["cst_icms"].zfill(n) for n in (2, 3)
                              if d["cst_icms"].zfill(n) in validos), d["cst_icms"])
    if d["cst_icms"] not in validos:
        erros.append(f"CST/CSOSN do ICMS deve ser um de: {', '.join(validos)}.")
    for campo, rotulo in (("cst_pis", "CST PIS"), ("cst_cofins", "CST COFINS")):
        d[campo] = d[campo].zfill(2) if len(d[campo]) == 1 else d[campo]
        if not re.fullmatch(r"\d{2}", d[campo]):
            erros.append(f"{rotulo} deve ter 2 dígitos.")
    return d, erros


def _ind_ie(bruto: str, ie: str) -> str:
    k = _chave(bruto)
    if k in ("1", "contribuinte", "contribuinte_icms", "sim"):
        return "1"
    if k in ("2", "isento", "contribuinte_isento"):
        return "2"
    if k in ("9", "nao_contribuinte", "nao", "nc"):
        return "9"
    if not k and ie:                                     # IE preenchida e sem indicador: é contribuinte
        return "1"
    return "9" if not k else bruto


def validar_cliente(m: dict, cep_fn=None):
    erros = []
    doc_bruto = normalizar_cnpj(m["documento"])
    if doc_bruto.isdigit():                              # o Excel come os zeros à esquerda
        if len(doc_bruto) <= 11:
            doc_bruto = doc_bruto.zfill(11)
        elif len(doc_bruto) < 14:
            doc_bruto = doc_bruto.zfill(14)
    if _NOTACAO.match(m["documento"] or ""):
        erros.append("CPF/CNPJ: o Excel converteu o número para notação científica. "
                     "Formate a coluna como Texto e digite de novo.")
    ie_txt = (m["ie"] or "").strip()
    ie = so_digitos(ie_txt)
    ind = _ind_ie(m["ind_ie_dest"], ie)
    if ie_txt.upper() == "ISENTO" and ind in ("2", "9"):      # "ISENTO" escrito na coluna da IE
        ind, ie = "2", ""
    d = {
        "documento": doc_bruto, "nome": limpar_texto(m["nome"], 60), "ind_ie_dest": ind, "ie": ie,
        "email": limpar_texto(m["email"], 60), "fone": so_digitos(m["fone"]),
        "logradouro": limpar_texto(m["logradouro"], 60), "numero": limpar_texto(m["numero"], 60),
        "complemento": limpar_texto(m["complemento"], 60), "bairro": limpar_texto(m["bairro"], 60),
        "cod_municipio": so_digitos(m["cod_municipio"]), "municipio": limpar_texto(m["municipio"], 60),
        "uf": (m["uf"] or "").strip().upper(), "cep": _digitos(m["cep"], "CEP", erros, 8),
    }
    # completa município/UF/IBGE (e endereço, se faltar) pelo CEP
    precisa_cep = (not d["cod_municipio"] or not d["municipio"] or not d["uf"]
                   or not d["logradouro"] or not d["bairro"])
    if precisa_cep and len(d["cep"]) == 8 and cep_fn is not None:
        info = cep_fn(d["cep"]) or {}
        d["cod_municipio"] = d["cod_municipio"] or so_digitos(info.get("ibge"))
        d["municipio"] = d["municipio"] or limpar_texto(info.get("localidade"), 60)
        d["uf"] = d["uf"] or (info.get("uf") or "").upper()
        d["logradouro"] = d["logradouro"] or limpar_texto(info.get("logradouro"), 60)
        d["bairro"] = d["bairro"] or limpar_texto(info.get("bairro"), 60)
    if not d["documento"]:
        erros.append("CPF/CNPJ não informado.")
    elif not validar_documento(d["documento"]):
        erros.append("CPF/CNPJ inválido.")
    if not d["nome"]:
        erros.append("Informe o nome.")
    for campo, rotulo in (("logradouro", "logradouro"), ("numero", "número"), ("bairro", "bairro"),
                          ("municipio", "município")):
        if not d[campo]:
            erros.append(f"Informe o {rotulo}.")
    if len(d["cod_municipio"]) != 7:
        erros.append("Código do município (IBGE) deve ter 7 dígitos (não consegui obter pelo CEP; "
                     "informe a coluna ou corrija o CEP).")
    if len(d["cep"]) != 8 and not any("CEP" in e for e in erros):
        erros.append("CEP deve ter 8 dígitos.")
    if d["uf"] not in T.UF_CODIGO:
        erros.append("UF inválida.")
    if d["ind_ie_dest"] not in ("1", "2", "9"):
        erros.append("Contribuinte ICMS deve ser 1 (contribuinte), 2 (isento) ou 9 (não contribuinte).")
    elif d["ind_ie_dest"] == "1" and not d["ie"]:
        erros.append("Contribuinte do ICMS precisa de Inscrição Estadual.")
    if d["email"] and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", d["email"]):
        erros.append("E-mail inválido.")
    return d, erros


# ------------------------------------------------------------------------------ gravação
class _ConsultaCep:
    """Consulta CEP com cache, limite de quantidade e de tempo (a importação não pode travar)."""

    def __init__(self, funcao, resultado: Resultado):
        self.funcao, self.res = funcao, resultado
        self.cache, self.n, self.t0, self.avisou = {}, 0, time.monotonic(), False

    def __call__(self, cep):
        if cep in self.cache:
            return self.cache[cep]
        if self.n >= MAX_CONSULTAS_CEP or time.monotonic() - self.t0 > TEMPO_MAX_CEP:
            if not self.avisou:
                self.res.avisos.append("Muitos CEPs para consultar de uma vez: as linhas restantes sem código "
                                       "IBGE foram recusadas. Preencha a coluna de código IBGE ou importe "
                                       "em partes menores.")
                self.avisou = True
            return {}
        self.n += 1
        try:
            info = self.funcao(cep) or {}
        except Exception:
            info = {}
        self.cache[cep] = info
        return info


_PREFIXOS_PRODUTO = [("NCM", "ncm"), ("CEST", "cest"), ("GTIN", "ean"), ("CFOP", "cfop"), ("Origem", "origem"),
                     ("CST/CSOSN", "cst_icms"), ("CST PIS", "cst_pis"), ("CST COFINS", "cst_cofins"),
                     ("Preço", "preco"), ("Alíquota ICMS", "aliq_icms"), ("Alíquota PIS", "aliq_pis"),
                     ("Alíquota COFINS", "aliq_cofins")]
_PREFIXOS_CLIENTE = [("CPF/CNPJ", "documento"), ("CEP", "cep"), ("UF", "uf"), ("Código do município", "cod_municipio"),
                     ("Contribuinte ICMS", "ind_ie_dest"), ("E-mail", "email")]


def _campos_ruins(erros, prefixos) -> set:
    return {campo for e in erros for pre, campo in prefixos if e.startswith(pre)}


def _codigo_automatico(descricao: str) -> str:
    return "IMP-" + hashlib.sha1(descricao.lower().encode()).hexdigest()[:8].upper()


def _identificar(tipo: str, fornecidos: dict, res: Resultado) -> str:
    if tipo == "produto":
        ident = limpar_texto(fornecidos.get("codigo", ""), 60)
        if not ident and fornecidos.get("descricao"):
            ident = _codigo_automatico(limpar_texto(fornecidos["descricao"], 120))
            res.codigos_automaticos += 1
        return ident
    ident = normalizar_cnpj(fornecidos.get("documento", ""))
    if ident.isdigit():
        ident = ident.zfill(11) if len(ident) <= 11 else (ident.zfill(14) if len(ident) < 14 else ident)
    return ident


def _buscar_atual(db, tipo: str, ident: str, fornecidos: dict):
    if tipo == "produto":
        return db.execute("SELECT * FROM produtos WHERE codigo = ?", (ident,)).fetchone() if ident else None
    if ident:
        return db.execute("SELECT * FROM clientes WHERE documento = ?", (ident,)).fetchone()
    nome = limpar_texto(fornecidos.get("nome", ""), 60)       # sem documento: reconhece pelo nome
    return db.execute("SELECT * FROM clientes WHERE documento = '' AND lower(nome) = lower(?)",
                      (nome,)).fetchone() if nome else None


def aplicar(db, tipo: str, registros, crt: str = "1", existentes: str = "atualizar", simular: bool = False,
            cep_fn=None, ignoradas=()) -> Resultado:
    """Valida e grava. `existentes`: 'atualizar' ou 'pular'. `simular`: valida tudo e não grava.

    Linha com problema é salva como cadastro incompleto (pendente=1, pendencias=o que falta). Em cadastro que
    já existia, o valor inválido da planilha é ignorado (mantém o que estava) e o fato é anotado em `ressalvas`.
    """
    res = Resultado(tipo=tipo, total=len(registros), simulado=simular, colunas_ignoradas=list(ignoradas))
    consulta = _ConsultaCep(cep_fn, res) if (tipo == "cliente" and cep_fn) else None
    tabela = "produtos" if tipo == "produto" else "clientes"
    prefixos = _PREFIXOS_PRODUTO if tipo == "produto" else _PREFIXOS_CLIENTE
    try:
        for linha, bruto in registros:
            fornecidos = {c: v for c, v in bruto.items() if v not in ("", None)}
            ident = _identificar(tipo, fornecidos, res)
            if tipo == "produto" and ident and "codigo" not in fornecidos:
                fornecidos["codigo"] = ident
            if not ident and not (tipo == "cliente" and fornecidos.get("nome")):
                res.erros.append((linha, ["Linha sem identificação: informe o código/descrição do produto."
                                          if tipo == "produto" else
                                          "Linha sem identificação: informe o CPF/CNPJ ou o nome do cliente."]))
                continue
            atual = _buscar_atual(db, tipo, ident, fornecidos)
            if atual is not None and existentes == "pular" and not atual["pendente"]:
                res.ignorados += 1
                continue
            if tipo == "produto":
                padrao = padrao_produto(crt)
                base = {k: str(atual[k]) for k in padrao} if atual else padrao
                dados, erros = validar_produto({**base, **fornecidos}, crt)
            else:
                modelo = {c: "" for c, *_ in CAMPOS_CLIENTE}
                base = {k: ("" if atual[k] is None else str(atual[k])) for k in modelo} if atual else modelo
                mesclado = {**base, **fornecidos}
                if atual is not None and "ind_ie_dest" not in fornecidos:
                    mesclado["ind_ie_dest"] = str(atual["ind_ie_dest"])
                dados, erros = validar_cliente(mesclado, consulta)

            if tipo == "produto":
                if not dados["descricao"]:
                    dados["descricao"] = dados["codigo"]
                if dados["ncm"] and len(dados["ncm"]) > 8:
                    dados["ncm"] = dados["ncm"][:8]
            elif not dados["nome"]:
                dados["nome"] = "(SEM NOME)"
            pendencias = list(erros)
            if erros:
                ruins = _campos_ruins(erros, prefixos)
                for campo in ruins & set(dados):
                    if atual is not None:                        # cadastro existente: mantém o valor antigo
                        dados[campo] = base[campo] if tipo == "produto" else (atual[campo] or "")
                    elif tipo == "produto" and campo != "ncm":
                        dados[campo] = padrao[campo]
                    elif tipo == "cliente" and campo in ("uf", "cod_municipio", "email"):
                        dados[campo] = ""
                    elif tipo == "cliente" and campo == "ind_ie_dest":
                        dados[campo] = "9"
                if atual is not None:
                    # o que continua faltando no cadastro depois de manter os valores antigos
                    if tipo == "produto":
                        pendencias = validar_produto({**{k: str(v) for k, v in dados.items()}}, crt)[1]
                    else:
                        pendencias = validar_cliente({k: str(v or "") for k, v in dados.items()}, consulta)[1]
            dados["pendente"] = 1 if pendencias else 0
            dados["pendencias"] = " | ".join(pendencias)[:900]

            if atual is not None:
                cols = list(dados)
                db.execute(f"UPDATE {tabela} SET {', '.join(c + '=?' for c in cols)} WHERE id=?",
                           [*dados.values(), atual["id"]])
                res.atualizados += 1
                if erros and not pendencias:
                    res.ressalvas.append((linha, erros))
            else:
                db.execute(f"INSERT INTO {tabela} ({', '.join(dados)}) VALUES ({', '.join('?' * len(dados))})",
                           list(dados.values()))
                res.criados += 1
            if pendencias:
                res.pendentes += 1
                res.incompletos.append((linha, pendencias))
        if simular:
            db.rollback()
        else:
            db.commit()
    except Exception:
        db.rollback()
        raise
    return res


# ------------------------------------------------------------------------------ modelos
def _exemplos(tipo: str):
    if tipo == "produto":
        return [["CAMISA-001", "Camisa de algodão branca", "61091000", "49,90", "UN", "5102", "102", "0", "0", "", "", "49", "0", "49", "0"],
                ["CALCA-002", "Calça jeans azul", "62034200", "129,90", "UN", "5102", "102", "0", "0", "", "7891234567895", "49", "0", "49", "0"]]
    return [["123.456.789-09", "Maria da Silva", "13201000", "Rua das Flores", "100", "Centro", "Jundiaí", "SP", "3525904", "Apto 2", "9", "", "maria@exemplo.com", "11999998888"],
            ["11.222.333/0001-81", "Comércio Exemplo Ltda", "01310100", "Avenida Paulista", "1000", "Bela Vista", "", "", "", "Sala 5", "1", "111222333444", "contato@exemplo.com", "1130303030"]]


def modelo_csv(tipo: str) -> bytes:
    campos = _TIPOS[tipo][0]
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";", lineterminator="\r\n")
    w.writerow([c for c, *_ in campos])
    w.writerows(_exemplos(tipo))
    return b"\xef\xbb\xbf" + buf.getvalue().encode("utf-8")      # BOM + ';' = abre certo no Excel BR


def modelo_xlsx(tipo: str) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    campos = _TIPOS[tipo][0]
    wb = Workbook()
    ws = wb.active
    ws.title = "Produtos" if tipo == "produto" else "Clientes"
    ws.append([c for c, *_ in campos])
    for celula in ws[1]:
        celula.font = Font(bold=True, color="FFFFFF")
        celula.fill = PatternFill("solid", fgColor="1F4E9E")
    for linha in _exemplos(tipo):
        ws.append(linha)
    for coluna in ws.columns:                            # tudo como TEXTO: o Excel não come zeros
        for celula in coluna:
            celula.number_format = "@"
        ws.column_dimensions[coluna[0].column_letter].width = max(14, len(str(coluna[0].value)) + 4)
    legenda = wb.create_sheet("Instruções")
    legenda.append(["Coluna", "Nome", "Obrigatória", "Observação"])
    for celula in legenda[1]:
        celula.font = Font(bold=True)
    for campo, rotulo, obrig, dica in campos:
        legenda.append([campo, rotulo, "sim" if obrig else "não", dica])
    legenda.append([])
    legenda.append(["Apague as linhas de exemplo antes de importar. Mantenha os nomes das colunas na primeira linha."])
    legenda.column_dimensions["A"].width = 16
    legenda.column_dimensions["B"].width = 28
    legenda.column_dimensions["D"].width = 80
    saida = io.BytesIO()
    wb.save(saida)
    return saida.getvalue()

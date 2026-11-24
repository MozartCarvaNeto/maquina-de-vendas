"""Funções de apoio: números, textos e validação de documentos."""
import re
import unicodedata
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

D = Decimal
ZERO = D("0.00")


def q2(valor) -> Decimal:
    return D(valor).quantize(D("0.01"), rounding=ROUND_HALF_UP)


def q4(valor) -> Decimal:
    return D(valor).quantize(D("0.0001"), rounding=ROUND_HALF_UP)


def parse_decimal(texto, padrao=None) -> Decimal | None:
    """Aceita '1.234,56', '1234,56' ou '1234.56'."""
    if texto is None:
        return padrao
    s = str(texto).strip().replace("R$", "").replace(" ", "")
    if not s:
        return padrao
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    try:
        return D(s)
    except InvalidOperation as exc:
        raise ValueError(f"Número inválido: {texto!r}") from exc


def fmt2(valor) -> str:
    return format(q2(valor), "f")


def fmt4(valor) -> str:
    return format(q4(valor), "f")


def fmt_unit(valor) -> str:
    """Valor unitário: 2 a 10 casas decimais, sem zeros sobrando."""
    s = format(D(valor).quantize(D("0.0000000001"), rounding=ROUND_HALF_UP), "f")
    inteiro, _, dec = s.partition(".")
    dec = dec.rstrip("0").ljust(2, "0")
    return f"{inteiro}.{dec}"


def fmt_aliq(valor) -> str:
    """Alíquotas (pICMS, pPIS...): 4 casas decimais."""
    return fmt4(valor)


def sem_acento(texto) -> str:
    """Minúsculas e sem acentos (para buscar 'joao' e achar 'JOÃO')."""
    return unicodedata.normalize("NFKD", str(texto or "")).encode("ascii", "ignore").decode().lower()


def so_digitos(texto) -> str:
    return re.sub(r"\D", "", str(texto or ""))


def limpar_texto(texto, max_len=None) -> str:
    """Remove quebras de linha/controle e espaços duplicados (a SEFAZ rejeita)."""
    if texto is None:
        return ""
    s = unicodedata.normalize("NFC", str(texto))
    s = re.sub(r"[\r\n\t]+", " ", s)
    s = "".join(ch for ch in s if ch == " " or unicodedata.category(ch)[0] != "C")
    s = re.sub(r" {2,}", " ", s).strip()
    if max_len:
        s = s[:max_len].strip()
    return s


def validar_cpf(cpf: str) -> bool:
    cpf = so_digitos(cpf)
    if len(cpf) != 11 or cpf == cpf[0] * 11:
        return False
    for n in (9, 10):
        soma = sum(int(cpf[i]) * (n + 1 - i) for i in range(n))
        dv = (soma * 10 % 11) % 10
        if dv != int(cpf[n]):
            return False
    return True


def normalizar_cnpj(cnpj: str) -> str:
    """Mantém letras e números (CNPJ alfanumérico, NT 2026.004)."""
    return re.sub(r"[^0-9A-Z]", "", str(cnpj or "").upper())


def validar_cnpj(cnpj: str) -> bool:
    """Valida CNPJ numérico ou alfanumérico (valor do caractere = ASCII - 48)."""
    c = normalizar_cnpj(cnpj)
    if len(c) != 14 or not re.fullmatch(r"[0-9A-Z]{12}[0-9]{2}", c):
        return False
    if c == c[0] * 14:
        return False
    pesos1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    pesos2 = [6] + pesos1
    for pesos, pos in ((pesos1, 12), (pesos2, 13)):
        soma = sum((ord(ch) - 48) * p for ch, p in zip(c[:pos], pesos))
        resto = soma % 11
        dv = 0 if resto < 2 else 11 - resto
        if dv != int(c[pos]):
            return False
    return True


def validar_documento(doc: str) -> bool:
    d = normalizar_cnpj(doc)
    if len(d) == 11:
        return validar_cpf(d)
    if len(d) == 14:
        return validar_cnpj(d)
    return False

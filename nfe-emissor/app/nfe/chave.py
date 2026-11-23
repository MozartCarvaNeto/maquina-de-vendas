"""Chave de acesso da NF-e (44 posições) e dígito verificador (módulo 11)."""
import random
import re


def dv_chave(base43: str) -> int:
    """DV módulo 11, pesos 2..9 da direita para a esquerda.

    Suporta CNPJ alfanumérico: cada caractere vale (código ASCII - 48).
    """
    soma, peso = 0, 2
    for ch in reversed(base43):
        soma += (ord(ch) - 48) * peso
        peso = 2 if peso == 9 else peso + 1
    resto = soma % 11
    return 0 if resto in (0, 1) else 11 - resto


def gerar_cnf(numero: int) -> str:
    """Código numérico aleatório de 8 dígitos (não pode repetir o nº da nota nem ser sequência)."""
    proibidos = {str(numero).zfill(8), "12345678", "23456789", "01234567"}
    while True:
        cnf = f"{random.SystemRandom().randrange(0, 10**8):08d}"
        if cnf in proibidos or re.fullmatch(r"(\d)\1{7}", cnf):
            continue
        return cnf


def montar_chave(cuf: str, aamm: str, cnpj: str, modelo: str, serie: int,
                 numero: int, tp_emis: int, cnf: str) -> str:
    base = (f"{cuf}{aamm}{cnpj}{modelo}{int(serie):03d}{int(numero):09d}"
            f"{tp_emis}{cnf}")
    if len(base) != 43:
        raise ValueError(f"Base da chave com tamanho inválido ({len(base)}): {base}")
    return base + str(dv_chave(base))

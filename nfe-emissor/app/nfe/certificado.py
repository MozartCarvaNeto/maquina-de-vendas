"""Leitura do certificado digital A1 (.pfx / .p12)."""
import os
import re
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone

from cryptography import x509
from cryptography.hazmat.primitives.serialization import (
    Encoding, NoEncryption, PrivateFormat, pkcs12)
from cryptography.x509.oid import NameOID


class CertificadoErro(Exception):
    pass


@dataclass
class Certificado:
    chave_privada: object
    cert: x509.Certificate
    cadeia: list

    @property
    def titular(self) -> str:
        attrs = self.cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)
        return attrs[0].value if attrs else self.cert.subject.rfc4514_string()

    @property
    def cnpj(self) -> str | None:
        """O e-CNPJ ICP-Brasil traz o CNPJ no fim do CN: 'RAZAO SOCIAL:12345678000190'."""
        m = re.search(r":([0-9A-Z]{14})$", self.titular.upper())
        return m.group(1) if m else None

    @property
    def validade_inicio(self) -> datetime:
        return self.cert.not_valid_before_utc

    @property
    def validade_fim(self) -> datetime:
        return self.cert.not_valid_after_utc

    @property
    def vencido(self) -> bool:
        return self.validade_fim < datetime.now(timezone.utc)

    def cert_der_base64(self) -> str:
        import base64
        return base64.b64encode(self.cert.public_bytes(Encoding.DER)).decode()


def carregar_pfx(dados: bytes, senha: str) -> Certificado:
    try:
        chave, cert, extras = pkcs12.load_key_and_certificates(dados, senha.encode("utf-8"))
    except Exception as exc:  # senha errada, arquivo inválido
        raise CertificadoErro(
            "Não foi possível abrir o certificado. Verifique a senha e se o arquivo é um "
            "certificado A1 (.pfx/.p12)."
        ) from exc
    if chave is None or cert is None:
        raise CertificadoErro("O arquivo não contém chave privada e certificado.")
    return Certificado(chave, cert, list(extras or []))


@contextmanager
def pem_temporario(cert: Certificado):
    """Gera um PEM temporário (certificado + cadeia + chave) para o TLS com a SEFAZ.

    O arquivo existe só durante a chamada e é apagado em seguida.
    """
    pem = cert.cert.public_bytes(Encoding.PEM)
    for extra in cert.cadeia:
        pem += extra.public_bytes(Encoding.PEM)
    pem += cert.chave_privada.private_bytes(
        Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
    fd, caminho = tempfile.mkstemp(suffix=".pem")
    try:
        os.chmod(caminho, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(pem)
        yield caminho
    finally:
        try:
            os.remove(caminho)
        except OSError:
            pass

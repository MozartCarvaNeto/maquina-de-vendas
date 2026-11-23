"""Configuração da aplicação (tudo via variáveis de ambiente)."""
import os
import secrets
from datetime import timedelta
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "data")).resolve()


def _secret_key() -> str:
    """SECRET_KEY: vem do ambiente; se não existir, é gerada e guardada em data/secret.key.

    Ela protege a sessão de login e a senha do certificado digital guardada no banco.
    Se ela for perdida, será preciso reenviar o certificado.
    """
    env = os.environ.get("SECRET_KEY")
    if env:
        return env
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    arquivo = DATA_DIR / "secret.key"
    if arquivo.exists():
        return arquivo.read_text().strip()
    chave = secrets.token_hex(32)
    arquivo.write_text(chave)
    os.chmod(arquivo, 0o600)
    return chave


class Config:
    DATA_DIR = DATA_DIR
    SECRET_KEY = _secret_key()
    DB_PATH = DATA_DIR / "nfe.db"
    CERT_DIR = DATA_DIR / "certs"
    XML_DIR = DATA_DIR / "xmls"
    SCHEMAS_DIR = DATA_DIR / "schemas"
    SEFAZ_URLS_OVERRIDE = DATA_DIR / "sefaz_urls.json"
    PREFIXO = os.environ.get("NFE_PREFIXO", "/nfe-app")   # endereço sob o qual o Turbo Prospect publica o emissor
    SESSION_COOKIE_NAME = "nfe_session"
    SESSION_COOKIE_PATH = os.environ.get("NFE_PREFIXO", "/nfe-app")

    MAX_CONTENT_LENGTH = 10 * 1024 * 1024  # upload máximo de 10 MB (certificado, cadeia ICP-Brasil)

    # Cookies de sessão. COOKIE_SECURE=0 só para testar localmente sem HTTPS.
    SESSION_COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "1") == "1"
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    PERMANENT_SESSION_LIFETIME = timedelta(hours=8)

    # Comunicação com a SEFAZ
    SEFAZ_CA_BUNDLE = os.environ.get("SEFAZ_CA_BUNDLE") or None  # cadeia ICP-Brasil (PEM)
    SEFAZ_TIMEOUT = int(os.environ.get("SEFAZ_TIMEOUT", "60"))

    TIMEZONE = os.environ.get("TZ_NFE", "America/Sao_Paulo")
    VER_PROC = "NFeEmissor 1.0"

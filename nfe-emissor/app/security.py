"""Login, CSRF e criptografia da senha do certificado."""
import base64
import hashlib
import hmac
import secrets
import time
from functools import wraps

from cryptography.fernet import Fernet, InvalidToken
from flask import abort, current_app, g, request, session


# ---------- criptografia da senha do certificado ----------
def _fernet() -> Fernet:
    # chave própria de cada conta: o segredo de uma não decifra o da outra
    chave = hashlib.sha256(f'{current_app.config["SECRET_KEY"]}:{g.conta}'.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(chave))


def cifrar(texto: str) -> str:
    return _fernet().encrypt(texto.encode()).decode()


def decifrar(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken as exc:
        raise ValueError(
            "Não foi possível decifrar a senha do certificado (SECRET_KEY mudou?). "
            "Envie o certificado novamente."
        ) from exc


# ---------- CSRF ----------
def csrf_token() -> str:
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(32)
    return session["csrf"]


def verificar_csrf():
    if request.method == "POST":
        enviado = request.form.get("csrf_token", "")
        esperado = session.get("csrf", "")
        if not esperado or not hmac.compare_digest(enviado, esperado):
            abort(400, "Token CSRF inválido. Recarregue a página e tente de novo.")


# ---------- acesso ----------
def login_required(view):
    """O login é do Turbo Prospect (ver tenant.autenticar); aqui só garante que há uma conta identificada."""
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not getattr(g, "conta", None):
            abort(403, "Acesso ao emissor negado. Entre pelo Turbo Prospect.")
        return view(*args, **kwargs)

    return wrapper

"""Várias contas (empresas) no mesmo emissor, com o login do Turbo Prospect.

Quem autentica é o Turbo Prospect (Node). Ele repassa cada requisição a este serviço — que só escuta em
127.0.0.1 — com cabeçalhos ASSINADOS (HMAC-SHA256 com NFE_INTERNAL_SECRET) dizendo qual conta e qual
usuário estão logados e qual o limite de notas do plano. Este serviço NÃO tem login próprio: sem
assinatura válida, recusa tudo.

Isolamento: cada conta tem a sua pasta  DATA_DIR/contas/<id-da-conta>/  com banco próprio (nfe.db),
certificado, XMLs, endereços da SEFAZ e numeração. Uma conta nunca enxerga os dados de outra.
"""
import hashlib
import hmac
import os
import re
import sqlite3
import threading
import time
from collections import ChainMap
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from flask import abort, current_app, g, request

JANELA_SEGUNDOS = 300           # tolerância de relógio entre o Turbo e este serviço
_ID_OK = re.compile(r"^[0-9a-zA-Z-]{8,64}$")
_PRONTAS: set[str] = set()
_trava = threading.Lock()


def segredo() -> str:
    return os.environ.get("NFE_INTERNAL_SECRET", "")


def assinatura(conta: str, usuario: str, papel: str, limite: str, leitura: str, ts: str) -> str:
    corpo = "|".join([conta, usuario, papel, limite, leitura, ts])
    return hmac.new(segredo().encode(), corpo.encode(), hashlib.sha256).hexdigest()


def autenticar():
    """before_request: valida a assinatura e define g.conta / g.usuario / g.papel / g.limite_mensal."""
    if request.endpoint in ("static", "main.healthz"):
        return None
    if not segredo():
        if os.environ.get("NFE_MODO_LOCAL") == "1":      # só para testar no seu computador
            g.conta, g.usuario, g.papel, g.limite_mensal, g.somente_leitura = "local-dev", "local", "owner", None, False
            preparar(g.conta)
            return None
        abort(503, "Emissor sem NFE_INTERNAL_SECRET configurado.")
    h = request.headers
    conta = h.get("X-Turbo-Account", "")
    usuario = h.get("X-Turbo-User", "")
    papel = h.get("X-Turbo-Role", "")
    limite = h.get("X-Turbo-Limit", "")
    leitura = h.get("X-Turbo-ReadOnly", "0")
    ts = h.get("X-Turbo-Ts", "")
    sig = h.get("X-Turbo-Sig", "")
    esperado = assinatura(conta, usuario, papel, limite, leitura, ts)
    try:
        recente = abs(time.time() - int(ts)) <= JANELA_SEGUNDOS
    except ValueError:
        recente = False
    if not (sig and recente and hmac.compare_digest(sig, esperado) and _ID_OK.match(conta)):
        abort(403, "Acesso ao emissor negado. Entre pelo Turbo Prospect.")
    g.conta, g.usuario, g.papel = conta, usuario, papel
    g.limite_mensal = int(limite) if limite.isdigit() else None   # None = sem limite
    g.somente_leitura = leitura == "1"
    if g.somente_leitura and request.method not in ("GET", "HEAD"):
        abort(403, "Seu plano de NF-e está vencido: só é possível consultar e baixar notas. Renove em Minha assinatura.")
    preparar(g.conta)
    return None


def pasta_conta(conta: str | None = None) -> Path:
    return Path(current_app.config["DATA_DIR"]) / "contas" / (conta or g.conta)


def cfg() -> ChainMap:
    """Configuração com os caminhos da conta logada por cima da configuração global."""
    base = pasta_conta()
    return ChainMap({
        "DB_PATH": base / "nfe.db",
        "CERT_DIR": base / "certs",
        "XML_DIR": base / "xmls",
        "SEFAZ_URLS_OVERRIDE": base / "sefaz_urls.json",
    }, current_app.config)


def preparar(conta: str):
    """Cria pastas e tabelas da conta na primeira vez que ela é usada neste processo."""
    if conta in _PRONTAS:
        return
    from .db import SCHEMA
    with _trava:
        base = pasta_conta(conta)
        for sub in ("", "certs", "xmls"):
            (base / sub).mkdir(parents=True, exist_ok=True)
        os.chmod(base, 0o700)
        con = sqlite3.connect(base / "nfe.db")
        con.execute("PRAGMA journal_mode = WAL")
        con.executescript(SCHEMA)
        con.commit()
        con.close()
        _PRONTAS.add(conta)


# ---------- cota mensal de notas do plano ----------
def periodo_atual() -> str:
    return datetime.now(ZoneInfo(current_app.config["TIMEZONE"])).strftime("%Y-%m")


def notas_no_mes(db, periodo: str | None = None) -> int:
    """Notas de PRODUÇÃO autorizadas no mês (homologação é teste e não conta)."""
    periodo = periodo or periodo_atual()
    return db.execute(
        "SELECT COUNT(*) n FROM notas WHERE ambiente = '1' AND status IN ('autorizada', 'cancelada') "
        "AND substr(dh_autorizacao, 1, 7) = ?", (periodo,)).fetchone()["n"]


def uso(db) -> dict:
    usadas = notas_no_mes(db)
    limite = g.limite_mensal
    return {"periodo": periodo_atual(), "usadas": usadas, "limite": limite,
            "restantes": None if limite is None else max(0, limite - usadas)}


def erro_de_cota(db, ambiente: str) -> str | None:
    """Mensagem se a emissão em PRODUÇÃO estourou o limite mensal do plano; senão None."""
    if str(ambiente) != "1" or g.limite_mensal is None:
        return None
    usadas = notas_no_mes(db)
    if usadas >= g.limite_mensal:
        return (f"Limite de {g.limite_mensal} nota(s) por mês do seu plano de NF-e atingido ({usadas} emitidas em "
                f"{periodo_atual()}). Ele zera no começo do próximo mês, ou contrate um plano maior em Minha assinatura.")
    return None

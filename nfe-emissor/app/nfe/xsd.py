"""Validação opcional do XML contra os XSD oficiais da NF-e.

Baixe o "Pacote de Liberação" de schemas vigente no Portal Nacional da NF-e
(nfe.fazenda.gov.br -> Documentos -> Esquemas XML), extraia os .xsd dentro de
data/schemas/ e a validação passa a rodar automaticamente antes de cada envio.
Sem os arquivos, a validação local é ignorada (a SEFAZ continua validando).
"""
from pathlib import Path

from lxml import etree

_CACHE: dict[str, etree.XMLSchema] = {}


def validar(xml: str | bytes, nome_xsd: str, pasta: Path) -> list[str] | None:
    """Devolve lista de erros ([] = válido) ou None se o XSD não estiver instalado."""
    caminho = Path(pasta) / nome_xsd
    if not caminho.exists():
        return None
    chave = str(caminho)
    if chave not in _CACHE:
        _CACHE[chave] = etree.XMLSchema(etree.parse(chave))
    schema = _CACHE[chave]
    if isinstance(xml, str):
        xml = xml.encode("utf-8")
    doc = etree.fromstring(xml)
    if schema.validate(doc):
        return []
    return [f"linha {e.line}: {e.message}" for e in schema.error_log][:20]

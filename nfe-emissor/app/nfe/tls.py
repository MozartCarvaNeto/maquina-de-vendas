"""Confiança TLS para falar com a SEFAZ.

Os servidores da SEFAZ usam certificados da cadeia ICP-Brasil, que NÃO vem no Python/Windows/Linux.
Este módulo:
  - baixa a cadeia oficial (Instituto Nacional de Tecnologia da Informação - ITI) e guarda em DATA_DIR;
  - aceita um arquivo de cadeia enviado pelo usuário (.pem/.crt/.cer/.zip);
  - monta um pacote único (CAs comuns + ICP-Brasil + o que o usuário apontou em SEFAZ_CA_BUNDLE);
  - cria uma sessão HTTPS que aceita os certificados ICP-Brasil (que não trazem alguns campos que o
    modo "estrito" do Python 3.13 exige).
"""
import io
import ssl
import zipfile
from pathlib import Path

import certifi
import requests
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from requests.adapters import HTTPAdapter

URLS_CADEIA = (
    "https://acraiz.icpbrasil.gov.br/credenciadas/CertificadosAC-ICP-Brasil/ACcompactado.zip",
    "https://www.gov.br/iti/pt-br/assuntos/repositorio/arquivos/acraiz/ACcompactado.zip",
)
NOME_CADEIA = "cadeia-icp-brasil.pem"
NOME_COMBINADO = "ca-combinado.pem"


class CadeiaErro(Exception):
    pass


def _certificados(blob: bytes) -> list:
    """Lê certificados de um arquivo PEM (um ou vários) ou DER (um)."""
    certs = []
    if b"BEGIN CERTIFICATE" in blob:
        try:
            return list(x509.load_pem_x509_certificates(blob))
        except ValueError:
            return []
    try:
        certs.append(x509.load_der_x509_certificate(blob))
    except ValueError:
        pass
    return certs


def extrair_certificados(blob: bytes, nome: str = "") -> list:
    """Aceita .zip (com vários .crt/.cer/.pem) ou um arquivo de certificado/cadeia."""
    if blob[:2] == b"PK":
        achados = []
        try:
            with zipfile.ZipFile(io.BytesIO(blob)) as z:
                for info in z.infolist():
                    if info.is_dir() or info.file_size > 2_000_000:
                        continue
                    if info.filename.lower().endswith((".crt", ".cer", ".pem", ".der")):
                        achados += _certificados(z.read(info))
        except zipfile.BadZipFile as exc:
            raise CadeiaErro("O arquivo .zip está corrompido.") from exc
        return achados
    return _certificados(blob)


def _ac_raiz_icp(certs) -> bool:
    for c in certs:
        if c.issuer == c.subject and "ICP-Brasil" in c.subject.rfc4514_string():
            return True
    return False


def salvar_cadeia(data_dir: Path, certs: list) -> int:
    """Grava a cadeia (sem duplicar). Exige ao menos uma AC Raiz ICP-Brasil, para não aceitar lixo."""
    if not certs:
        raise CadeiaErro("Nenhum certificado encontrado no arquivo.")
    destino = Path(data_dir) / NOME_CADEIA
    existentes = _certificados(destino.read_bytes()) if destino.exists() else []
    todos = {c.fingerprint(hashes.SHA256()): c
             for c in existentes + certs}
    if not _ac_raiz_icp(list(todos.values())):
        raise CadeiaErro("O arquivo não contém a AC Raiz da ICP-Brasil. Baixe o pacote "
                         "\"ACcompactado.zip\" no site do ITI (repositório de cadeias de certificados).")
    Path(data_dir).mkdir(parents=True, exist_ok=True)
    pem = b"".join(c.public_bytes(serialization.Encoding.PEM) for c in todos.values())
    destino.write_bytes(pem)
    (Path(data_dir) / NOME_COMBINADO).unlink(missing_ok=True)   # será refeito
    return len(todos)


def baixar_cadeia(data_dir: Path, timeout: int = 40) -> int:
    ultimo = None
    for url in URLS_CADEIA:
        try:
            r = requests.get(url, timeout=timeout)
            r.raise_for_status()
            return salvar_cadeia(data_dir, extrair_certificados(r.content))
        except (requests.RequestException, CadeiaErro) as exc:
            ultimo = exc
    raise CadeiaErro(
        "Não consegui baixar a cadeia ICP-Brasil automaticamente "
        f"({str(ultimo)[:150]}). Baixe o arquivo ACcompactado.zip no site do ITI "
        "(gov.br/iti > Repositório > Cadeias de certificados) e envie-o em Configurações.")


def tem_cadeia(data_dir: Path) -> bool:
    return (Path(data_dir) / NOME_CADEIA).exists()


def pacote_confianca(data_dir: Path, extra: str | None = None) -> str:
    """Caminho de um .pem com: CAs comuns + cadeia ICP-Brasil (se houver) + `extra` (se houver)."""
    partes = [Path(certifi.where())]
    icp = Path(data_dir) / NOME_CADEIA
    if icp.exists():
        partes.append(icp)
    if extra and Path(extra).exists():
        partes.append(Path(extra))
    destino = Path(data_dir) / NOME_COMBINADO
    ref = max(p.stat().st_mtime for p in partes)
    if not destino.exists() or destino.stat().st_mtime < ref :
        Path(data_dir).mkdir(parents=True, exist_ok=True)
        destino.write_bytes(b"\n".join(p.read_bytes() for p in partes))
    return str(destino)


class _Adaptador(HTTPAdapter):
    def __init__(self, cafile: str, **kw):
        self._cafile = cafile
        super().__init__(**kw)

    def _ctx(self):
        ctx = ssl.create_default_context(cafile=self._cafile)
        # Os certificados ICP-Brasil não atendem ao modo estrito do Python 3.13 (ex.: sem AKI).
        ctx.verify_flags &= ~getattr(ssl, "VERIFY_X509_STRICT", 0)
        return ctx

    def init_poolmanager(self, *a, **kw):
        kw["ssl_context"] = self._ctx()
        super().init_poolmanager(*a, **kw)

    def proxy_manager_for(self, *a, **kw):
        kw["ssl_context"] = self._ctx()
        return super().proxy_manager_for(*a, **kw)


def sessao(cafile: str) -> requests.Session:
    s = requests.Session()
    s.mount("https://", _Adaptador(cafile))
    s.verify = cafile
    return s

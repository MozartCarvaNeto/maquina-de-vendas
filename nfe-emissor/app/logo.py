"""Logotipo da empresa impresso no topo do DANFE.

Cada conta (empresa) tem o seu: fica em  <pasta da conta>/logo.png  (ou DATA_DIR/logo.png no
emissor avulso). A imagem enviada nunca é guardada como veio: é aberta, conferida, achatada sobre
fundo branco, reduzida e regravada como PNG novo. Isso descarta metadados e qualquer conteúdo
estranho dentro do arquivo. SVG não é aceito.
"""
import io
import os
from pathlib import Path

from flask import current_app, g
from PIL import Image, ImageOps, UnidentifiedImageError

ARQUIVO = "logo.png"
TAMANHO_MAX = 2 * 1024 * 1024      # arquivo enviado: até 2 MB
PIXELS_MAX = 25_000_000            # protege contra "bomba de descompressão"
LADO_MIN = 20
LADO_SAIDA = 640                   # guardado em até 640 x 640 px (sobra para imprimir nítido)
FORMATOS = {"PNG", "JPEG", "WEBP"}


class LogoInvalido(ValueError):
    """Mensagem já pronta para mostrar ao usuário."""


def pasta() -> Path:
    conta = getattr(g, "conta", None)
    if conta:                                   # Turbo Prospect: uma pasta por conta
        from . import tenant
        return tenant.pasta_conta(conta)
    return Path(current_app.config["DATA_DIR"])  # emissor avulso: uma empresa só


def caminho() -> Path:
    return pasta() / ARQUIVO


def existe() -> bool:
    return caminho().is_file()


def versao() -> int:
    """Muda a cada troca (evita o navegador mostrar o logotipo antigo)."""
    try:
        return int(caminho().stat().st_mtime)
    except OSError:
        return 0


def ler() -> bytes | None:
    try:
        return caminho().read_bytes()
    except OSError:
        return None


def remover() -> bool:
    try:
        caminho().unlink()
        return True
    except FileNotFoundError:
        return False


def normalizar(dados: bytes) -> bytes:
    """Valida a imagem enviada e devolve o PNG limpo que será guardado."""
    if not dados:
        raise LogoInvalido("Escolha um arquivo de imagem.")
    if len(dados) > TAMANHO_MAX:
        raise LogoInvalido("Imagem grande demais: o máximo é 2 MB.")
    msg_formato = "Arquivo não reconhecido. Envie uma imagem PNG, JPG ou WEBP (SVG não é aceito)."
    try:
        img = Image.open(io.BytesIO(dados))
        formato = img.format
        largura, altura = img.size
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, ValueError):
        raise LogoInvalido(msg_formato) from None
    if formato not in FORMATOS:
        raise LogoInvalido(msg_formato)
    if largura * altura > PIXELS_MAX:
        raise LogoInvalido("Imagem com dimensões grandes demais. Reduza e tente de novo.")
    if min(largura, altura) < LADO_MIN:
        raise LogoInvalido("Imagem pequena demais para ser um logotipo legível.")
    try:
        img.load()
        img = ImageOps.exif_transpose(img)
        if img.mode in ("RGBA", "LA", "P"):      # transparência -> fundo branco (o DANFE é branco)
            img = img.convert("RGBA")
            fundo = Image.new("RGB", img.size, (255, 255, 255))
            fundo.paste(img, mask=img.getchannel("A"))
            img = fundo
        else:
            img = img.convert("RGB")
        img.thumbnail((LADO_SAIDA, LADO_SAIDA), Image.LANCZOS)
        saida = io.BytesIO()
        img.save(saida, "PNG", optimize=True)
    except (OSError, ValueError, Image.DecompressionBombError):
        raise LogoInvalido("Não foi possível ler esta imagem. Tente outro arquivo.") from None
    return saida.getvalue()


def salvar(dados: bytes) -> None:
    png = normalizar(dados)
    destino = caminho()
    destino.parent.mkdir(parents=True, exist_ok=True)
    temporario = destino.with_name(destino.name + ".tmp")
    temporario.write_bytes(png)
    os.chmod(temporario, 0o600)
    os.replace(temporario, destino)               # troca atômica

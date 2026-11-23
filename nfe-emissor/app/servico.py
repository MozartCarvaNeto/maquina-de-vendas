"""Orquestração: banco de dados + certificado + XML + assinatura + SEFAZ."""
import json
from datetime import datetime
from zoneinfo import ZoneInfo

from lxml import etree

from . import security
from .nfe import sefaz, xsd
from .nfe.assinatura import assinar, verificar
from .nfe.certificado import Certificado, CertificadoErro, carregar_pfx, pem_temporario
from .nfe.chave import gerar_cnf
from .nfe.sefaz_urls import autorizador_da_uf
from .nfe.tabelas import UF_CODIGO
from .nfe.util import ZERO, normalizar_cnpj, parse_decimal, q2
from .nfe.xml_builder import (NS, DadosInvalidos, construir_nfe, serializar, validar_dados)


class ErroNegocio(Exception):
    """Erro com mensagem apropriada para mostrar ao usuário."""


# ----------------------------------------------------------------------------------------
# Acesso a dados
# ----------------------------------------------------------------------------------------
def agora(cfg) -> datetime:
    return datetime.now(ZoneInfo(cfg["TIMEZONE"])).replace(microsecond=0)


def carregar_empresa(db) -> dict:
    return dict(db.execute("SELECT * FROM empresa WHERE id = 1").fetchone())


def carregar_nota(db, nota_id: int):
    nota = db.execute("SELECT * FROM notas WHERE id = ?", (nota_id,)).fetchone()
    if nota is None:
        raise ErroNegocio("Nota não encontrada.")
    nota = dict(nota)
    cliente = None
    if nota["cliente_id"]:
        row = db.execute("SELECT * FROM clientes WHERE id = ?", (nota["cliente_id"],)).fetchone()
        cliente = dict(row) if row else None
    itens = [dict(r) for r in db.execute(
        "SELECT * FROM nota_itens WHERE nota_id = ? ORDER BY ordem", (nota_id,))]
    return nota, cliente, itens


def total_nota(itens: list[dict], frete, outras, desconto) -> str:
    """Total da nota para exibição (a conta oficial é feita em xml_builder.calcular)."""
    soma = ZERO
    for it in itens:
        soma += q2(q2(parse_decimal(it["quantidade"])) * parse_decimal(it["valor_unitario"]))
    total = soma - q2(parse_decimal(desconto, ZERO)) + q2(parse_decimal(frete, ZERO)) \
        + q2(parse_decimal(outras, ZERO))
    return format(q2(total), "f")


def proximo_numero(db, ambiente: str, serie: str) -> int:
    db.commit()
    db.execute("BEGIN IMMEDIATE")
    try:
        row = db.execute("SELECT ultimo_numero FROM numeracao WHERE ambiente = ? AND serie = ?",
                         (ambiente, serie)).fetchone()
        numero = (row["ultimo_numero"] if row else 0) + 1
        db.execute(
            "INSERT INTO numeracao (ambiente, serie, ultimo_numero) VALUES (?, ?, ?) "
            "ON CONFLICT (ambiente, serie) DO UPDATE SET ultimo_numero = excluded.ultimo_numero",
            (ambiente, serie, numero))
        db.commit()
    except Exception:
        db.rollback()
        raise
    return numero


def definir_ultimo_numero(db, ambiente: str, serie: str, ultimo: int):
    db.execute(
        "INSERT INTO numeracao (ambiente, serie, ultimo_numero) VALUES (?, ?, ?) "
        "ON CONFLICT (ambiente, serie) DO UPDATE SET ultimo_numero = excluded.ultimo_numero",
        (ambiente, serie, ultimo))
    db.commit()


def ultimo_numero(db, ambiente: str, serie: str) -> int:
    row = db.execute("SELECT ultimo_numero FROM numeracao WHERE ambiente = ? AND serie = ?",
                     (ambiente, serie)).fetchone()
    return row["ultimo_numero"] if row else 0


# ----------------------------------------------------------------------------------------
# Certificado
# ----------------------------------------------------------------------------------------
def carregar_certificado(cfg, empresa: dict) -> Certificado:
    if not empresa.get("cert_arquivo") or not empresa.get("cert_senha_enc"):
        raise ErroNegocio("Nenhum certificado digital cadastrado. Envie o certificado A1 na "
                          "aba Configurações.")
    caminho = cfg["CERT_DIR"] / empresa["cert_arquivo"]
    if not caminho.exists():
        raise ErroNegocio("Arquivo do certificado não encontrado no servidor. Envie-o novamente.")
    try:
        cert = carregar_pfx(caminho.read_bytes(), security.decifrar(empresa["cert_senha_enc"]))
    except (CertificadoErro, ValueError) as exc:
        raise ErroNegocio(str(exc)) from exc
    if cert.vencido:
        raise ErroNegocio(f"O certificado digital venceu em {cert.validade_fim:%d/%m/%Y}.")
    cnpj_cert = cert.cnpj
    if cnpj_cert and normalizar_cnpj(cnpj_cert)[:8] != normalizar_cnpj(empresa["cnpj"])[:8]:
        raise ErroNegocio("O CNPJ do certificado não pertence à mesma raiz do CNPJ da empresa.")
    return cert


def urls_personalizadas(db, cfg) -> dict:
    """Endereços alterados pelo usuário: arquivo JSON (avançado) + painel Configurações."""
    tabela: dict = {}
    arquivo = cfg["SEFAZ_URLS_OVERRIDE"]
    if arquivo.exists():
        tabela = json.loads(arquivo.read_text(encoding="utf-8"))
    for r in db.execute("SELECT autorizador, ambiente, servico, url FROM sefaz_urls"):
        tabela.setdefault(r["autorizador"], {}).setdefault(r["ambiente"], {})[r["servico"]] = r["url"]
    return tabela


def _contexto(db, cfg, empresa: dict, pem: str) -> sefaz.Contexto:
    autorizador = empresa.get("autorizador") or autorizador_da_uf(empresa["uf"])
    return sefaz.Contexto(autorizador=autorizador, ambiente=str(empresa["ambiente"]), pem=pem,
                          timeout=cfg["SEFAZ_TIMEOUT"], ca_bundle=cfg["SEFAZ_CA_BUNDLE"], data_dir=cfg["DATA_DIR"],
                          urls_override=urls_personalizadas(db, cfg))


def _log(db, nota_id, operacao, ambiente, cstat, motivo, resposta):
    db.execute("INSERT INTO log_sefaz (nota_id, operacao, ambiente, c_stat, x_motivo, resposta) "
               "VALUES (?, ?, ?, ?, ?, ?)",
               (nota_id, operacao, ambiente, cstat, motivo, (resposta or "")[:20000]))
    db.commit()


def _arquivar_xml(cfg, chave: str, sufixo: str, xml: str, dh: datetime):
    pasta = cfg["XML_DIR"] / f"{dh:%Y-%m}"
    pasta.mkdir(parents=True, exist_ok=True)
    (pasta / f"{chave}-{sufixo}.xml").write_text(xml, encoding="utf-8")


# ----------------------------------------------------------------------------------------
# Operações
# ----------------------------------------------------------------------------------------
def testar_conexao(db, cfg) -> dict:
    empresa = carregar_empresa(db)
    if empresa["uf"] not in UF_CODIGO:
        raise ErroNegocio("Preencha a UF da empresa antes de testar.")
    cert = carregar_certificado(cfg, empresa)
    with pem_temporario(cert) as pem:
        ctx = _contexto(db, cfg, empresa, pem)
        try:
            r = sefaz.status_servico(UF_CODIGO[empresa["uf"]], ctx)
        except (sefaz.SefazErro, KeyError) as exc:
            raise ErroNegocio(str(exc)) from exc
    _log(db, None, "status", ctx.ambiente, r["cstat"], r["xmotivo"], r["resposta"])
    r["autorizador"] = ctx.autorizador
    return r


def emitir(db, cfg, nota_id: int) -> dict:
    nota, cliente, itens = carregar_nota(db, nota_id)
    if nota["status"] not in ("rascunho", "rejeitada"):
        raise ErroNegocio(f"Esta nota está '{nota['status']}' e não pode ser emitida novamente."
                          + (" Use 'Consultar situação'." if nota["status"] == "pendente" else ""))
    empresa = carregar_empresa(db)
    ambiente = str(empresa["ambiente"])
    serie = str(empresa["serie"])
    cert = carregar_certificado(cfg, empresa)

    erros = validar_dados(empresa, cliente, itens, nota)
    if erros:
        raise DadosInvalidos(erros)

    # número: mantém o já reservado para esta nota se o ambiente/série não mudaram
    if nota["numero"] and nota["ambiente"] == ambiente and nota["serie"] == serie:
        numero = nota["numero"]
    else:
        numero = proximo_numero(db, ambiente, serie)

    dh = agora(cfg)
    nota.update(serie=serie)
    nfe_el, chave, _calc = construir_nfe(
        empresa, cliente, itens, nota, numero=numero, dh_emissao=dh, cnf=gerar_cnf(numero),
        tp_amb=ambiente, ver_proc=cfg["VER_PROC"])
    inf = nfe_el.find(f"{{{NS}}}infNFe")
    assinar(nfe_el, inf, cert)
    if not verificar(nfe_el):  # autoteste: nunca deve falhar
        raise ErroNegocio("Falha interna ao assinar o XML.")
    xml_assinado = serializar(nfe_el)

    # validação local opcional com os XSD oficiais
    envio = f'<enviNFe xmlns="{NS}" versao="4.00"><idLote>1</idLote><indSinc>1</indSinc>{xml_assinado}</enviNFe>'
    erros_xsd = xsd.validar(envio, "enviNFe_v4.00.xsd", cfg["SCHEMAS_DIR"])
    if erros_xsd:
        db.execute("UPDATE notas SET status='rejeitada', numero=?, ambiente=?, serie=?, chave=?, "
                   "xml_assinado=?, c_stat='XSD', x_motivo=?, dh_emissao=? WHERE id=?",
                   (numero, ambiente, serie, chave, xml_assinado,
                    "Validação local (XSD): " + " | ".join(erros_xsd[:5]), dh.isoformat(), nota_id))
        db.commit()
        return {"status": "rejeitada", "cstat": "XSD", "xmotivo": "Falha na validação local (XSD)."}

    # grava como 'pendente' ANTES de enviar: se a conexão cair, sabemos que é preciso consultar
    db.execute("UPDATE notas SET status='pendente', numero=?, ambiente=?, serie=?, chave=?, "
               "xml_assinado=?, xml_proc=NULL, protocolo=NULL, c_stat=NULL, x_motivo=NULL, "
               "dh_emissao=?, total_nf=? WHERE id=?",
               (numero, ambiente, serie, chave, xml_assinado, dh.isoformat(),
                format(q2(_calc["totais"]["vNF"]), "f"), nota_id))
    db.commit()
    _arquivar_xml(cfg, chave, "nfe-assinada", xml_assinado, dh)

    with pem_temporario(cert) as pem:
        ctx = _contexto(db, cfg, empresa, pem)
        try:
            r = sefaz.autorizar(nfe_el, chave, str(nota_id), ctx)
        except sefaz.SefazTimeout as exc:
            db.execute("UPDATE notas SET x_motivo=? WHERE id=?", (str(exc), nota_id))
            db.commit()
            raise ErroNegocio(f"{exc} A nota ficou PENDENTE: use 'Consultar situação' antes de "
                              "tentar de novo.") from exc
        except (sefaz.SefazErro, KeyError) as exc:
            # nada indica que a SEFAZ recebeu: volta a rascunho (mantém o número reservado)
            db.execute("UPDATE notas SET status='rascunho', x_motivo=? WHERE id=?",
                       (str(exc), nota_id))
            db.commit()
            raise ErroNegocio(str(exc)) from exc

    _log(db, nota_id, "autorizacao", ambiente, r["cstat"], r["xmotivo"], r["resposta"])
    db.execute("UPDATE notas SET status=?, c_stat=?, x_motivo=?, protocolo=?, recibo=?, "
               "dh_autorizacao=?, xml_proc=? WHERE id=?",
               (r["status"], r["cstat"], r["xmotivo"], r.get("protocolo"), r.get("recibo"),
                r.get("dh_autorizacao"), r.get("xml_proc"), nota_id))
    db.commit()
    if r["status"] == "autorizada":
        _arquivar_xml(cfg, chave, "procNFe", r["xml_proc"], dh)
    return r


def consultar(db, cfg, nota_id: int) -> dict:
    nota, _cliente, _itens = carregar_nota(db, nota_id)
    if not nota["chave"]:
        raise ErroNegocio("Esta nota ainda não tem chave de acesso (nunca foi enviada).")
    empresa = carregar_empresa(db)
    cert = carregar_certificado(cfg, empresa)
    nfe_el = None
    if nota["xml_assinado"]:
        nfe_el = etree.fromstring(nota["xml_assinado"].encode("utf-8"))
    with pem_temporario(cert) as pem:
        ctx = _contexto(db, cfg, empresa, pem)
        ctx.ambiente = str(nota["ambiente"] or empresa["ambiente"])
        try:
            r = sefaz.consultar_chave(nota["chave"], nfe_el, ctx)
        except (sefaz.SefazErro, KeyError) as exc:
            raise ErroNegocio(str(exc)) from exc
    _log(db, nota_id, "consulta", ctx.ambiente, r["cstat"], r["xmotivo"], r["resposta"])

    if r["status"] == "autorizada":
        db.execute("UPDATE notas SET status='autorizada', c_stat=?, x_motivo=?, protocolo=?, "
                   "dh_autorizacao=?, xml_proc=COALESCE(?, xml_proc) WHERE id=?",
                   (r["cstat"], r["xmotivo"], r["protocolo"], r["dh_autorizacao"],
                    r["xml_proc"], nota_id))
        if r["xml_proc"]:
            _arquivar_xml(cfg, nota["chave"], "procNFe", r["xml_proc"], agora(cfg))
    elif r["status"] == "cancelada":
        db.execute("UPDATE notas SET status='cancelada', c_stat=?, x_motivo=?, "
                   "cancel_protocolo=COALESCE(?, cancel_protocolo) WHERE id=?",
                   (r["cstat"], r["xmotivo"], r.get("cancel_protocolo"), nota_id))
    elif r["status"] == "denegada":
        db.execute("UPDATE notas SET status='denegada', c_stat=?, x_motivo=? WHERE id=?",
                   (r["cstat"], r["xmotivo"], nota_id))
    elif r["status"] == "nao_encontrada" and nota["status"] == "pendente":
        db.execute("UPDATE notas SET status='rejeitada', c_stat=?, x_motivo=? WHERE id=?",
                   (r["cstat"], "A SEFAZ não recebeu esta NF-e. Você pode emitir novamente.",
                    nota_id))
    db.commit()
    return r


def cancelar(db, cfg, nota_id: int, justificativa: str) -> dict:
    nota, _cliente, _itens = carregar_nota(db, nota_id)
    if nota["status"] != "autorizada" or not nota["protocolo"]:
        raise ErroNegocio("Só é possível cancelar uma nota autorizada.")
    empresa = carregar_empresa(db)
    cert = carregar_certificado(cfg, empresa)
    dh = agora(cfg)
    with pem_temporario(cert) as pem:
        ctx = _contexto(db, cfg, empresa, pem)
        ctx.ambiente = str(nota["ambiente"])
        try:
            r = sefaz.cancelar(cert=cert, cuf=UF_CODIGO[empresa["uf"]],
                               cnpj=normalizar_cnpj(empresa["cnpj"]), chave=nota["chave"],
                               protocolo=nota["protocolo"], justificativa=justificativa,
                               dh_evento=dh, ctx=ctx)
        except ValueError as exc:
            raise ErroNegocio(str(exc)) from exc
        except (sefaz.SefazErro, KeyError) as exc:
            raise ErroNegocio(str(exc)) from exc
    _log(db, nota_id, "cancelamento", ctx.ambiente, r["cstat"], r["xmotivo"], r["resposta"])
    if r["cancelada"]:
        db.execute("UPDATE notas SET status='cancelada', cancel_protocolo=?, cancel_xml=?, "
                   "cancel_motivo=?, cancel_dh=?, c_stat=?, x_motivo=? WHERE id=?",
                   (r["protocolo"], r["xml_evento"], " ".join(justificativa.split()),
                    dh.isoformat(), r["cstat"], r["xmotivo"], nota_id))
        db.commit()
        _arquivar_xml(cfg, nota["chave"], "procEventoCancelamento", r["xml_evento"], dh)
    return r


def validar_certificado_upload(dados: bytes, senha: str, empresa: dict) -> Certificado:
    try:
        cert = carregar_pfx(dados, senha)
    except CertificadoErro as exc:
        raise ErroNegocio(str(exc)) from exc
    if cert.vencido:
        raise ErroNegocio(f"Este certificado venceu em {cert.validade_fim:%d/%m/%Y}.")
    if cert.cnpj and empresa.get("cnpj") and \
            normalizar_cnpj(cert.cnpj)[:8] != normalizar_cnpj(empresa["cnpj"])[:8]:
        raise ErroNegocio(
            f"O certificado é do CNPJ {cert.cnpj}, que não tem a mesma raiz do CNPJ da empresa "
            f"({empresa['cnpj']}). A SEFAZ rejeitaria as notas.")
    return cert

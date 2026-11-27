"""Backup das notas fiscais (guarda de 5 anos é obrigação fiscal): ZIP com os XMLs + planilha de conferência.

O XML autorizado (procNFe) e o de cancelamento ficam no banco da conta E em arquivos (data/contas/<id>/xmls).
Aqui eles são reunidos num ZIP que o cliente baixa e guarda fora do servidor. Também serve ao backup
automático do servidor (deploy/backup-notas.sh) e confere se alguma nota perdeu o XML.
"""
import csv
import io
import re
import tempfile
import zipfile
from datetime import datetime

_MES = re.compile(r"^\d{4}-\d{2}$")

CAMPOS_MANIFESTO = ["ambiente", "serie", "numero", "chave", "status", "protocolo", "dh_emissao", "dh_autorizacao",
                    "total_nf", "cliente", "documento_cliente", "cancel_protocolo", "cancel_dh", "arquivo_xml", "arquivo_cancelamento"]


def validar_mes(mes: str | None) -> str | None:
    if mes in (None, "", "tudo"):
        return None
    if not _MES.match(mes):
        raise ValueError("Informe o mês no formato AAAA-MM.")
    return mes


def _notas(db, mes: str | None, ambiente: str | None):
    sql = ("SELECT n.*, c.nome AS cli_nome, c.documento AS cli_doc FROM notas n LEFT JOIN clientes c ON c.id = n.cliente_id "
           "WHERE n.status IN ('autorizada', 'cancelada')")
    args: list = []
    if ambiente in ("1", "2"):
        sql += " AND n.ambiente = ?"
        args.append(ambiente)
    if mes:
        sql += " AND substr(COALESCE(n.dh_autorizacao, n.dh_emissao), 1, 7) = ?"
        args.append(mes)
    return db.execute(sql + " ORDER BY n.ambiente, n.serie, n.numero", args).fetchall()


def resumo(db) -> dict:
    """Números da tela de backup: notas guardadas por mês e as que estão sem XML (problema a corrigir)."""
    meses = {}
    sem_xml = 0
    for n in _notas(db, None, None):
        mes = (n["dh_autorizacao"] or n["dh_emissao"] or "")[:7] or "sem-data"
        m = meses.setdefault(mes, {"mes": mes, "autorizadas": 0, "canceladas": 0, "producao": 0, "homologacao": 0})
        m["canceladas" if n["status"] == "cancelada" else "autorizadas"] += 1
        m["producao" if n["ambiente"] == "1" else "homologacao"] += 1
        if not n["xml_proc"]:
            sem_xml += 1
    return {"meses": sorted(meses.values(), key=lambda m: m["mes"], reverse=True),
            "total": sum(m["autorizadas"] + m["canceladas"] for m in meses.values()), "sem_xml": sem_xml}


def gerar_zip(db, mes: str | None = None, ambiente: str | None = "1", com_cadastros: bool = True):
    """Devolve (arquivo_temporario_aberto, quantidade). O ZIP vai para o disco para não estourar a memória."""
    mes = validar_mes(mes)
    notas = _notas(db, mes, ambiente)
    tmp = tempfile.SpooledTemporaryFile(max_size=32 * 1024 * 1024)
    manifesto = io.StringIO()
    w = csv.DictWriter(manifesto, fieldnames=CAMPOS_MANIFESTO, delimiter=";")
    w.writeheader()
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for n in notas:
            pasta = f"{'producao' if n['ambiente'] == '1' else 'homologacao'}/{(n['dh_autorizacao'] or n['dh_emissao'] or 'sem-data')[:7]}"
            arq_xml = arq_canc = ""
            if n["xml_proc"]:
                arq_xml = f"{pasta}/{n['chave']}-procNFe.xml"
                z.writestr(arq_xml, n["xml_proc"])
            if n["cancel_xml"]:
                arq_canc = f"{pasta}/{n['chave']}-cancelamento.xml"
                z.writestr(arq_canc, n["cancel_xml"])
            w.writerow({"ambiente": "produção" if n["ambiente"] == "1" else "homologação", "serie": n["serie"], "numero": n["numero"],
                        "chave": n["chave"], "status": n["status"], "protocolo": n["protocolo"], "dh_emissao": n["dh_emissao"],
                        "dh_autorizacao": n["dh_autorizacao"], "total_nf": n["total_nf"], "cliente": n["cli_nome"],
                        "documento_cliente": n["cli_doc"], "cancel_protocolo": n["cancel_protocolo"], "cancel_dh": n["cancel_dh"],
                        "arquivo_xml": arq_xml, "arquivo_cancelamento": arq_canc})
        z.writestr("notas.csv", "﻿" + manifesto.getvalue())
        if com_cadastros:
            for tabela, colunas in (("produtos", "codigo,descricao,ncm,cest,ean,unidade,preco,origem,cfop,cst_icms,ativo"),
                                    ("clientes", None)):
                try:
                    cur = db.execute(f"SELECT {colunas or '*'} FROM {tabela}")
                except Exception:
                    continue
                buf = io.StringIO()
                cw = csv.writer(buf, delimiter=";")
                cw.writerow([d[0] for d in cur.description])
                cw.writerows([tuple(r) for r in cur.fetchall()])
                z.writestr(f"{tabela}.csv", "﻿" + buf.getvalue())
        z.writestr("LEIA-ME.txt",
                   "Backup das notas fiscais eletrônicas gerado em %s.\n\n"
                   "Guarde este arquivo em lugar seguro, FORA do servidor (por lei, os XMLs devem ser guardados por 5 anos).\n"
                   "- producao/AAAA-MM/ : XMLs autorizados (procNFe) e de cancelamento, válidos perante a SEFAZ.\n"
                   "- homologacao/      : notas de teste (sem valor fiscal).\n"
                   "- notas.csv         : lista de conferência (chave, número, protocolo, valor, cliente).\n"
                   "- produtos.csv / clientes.csv : seus cadastros.\n" % datetime.now().strftime("%d/%m/%Y %H:%M"))
    tmp.seek(0)
    return tmp, len(notas)


def reparar_arquivos(db, cfg) -> int:
    """Regrava em disco os XMLs que existem no banco mas sumiram da pasta (o banco é a fonte principal)."""
    refeitos = 0
    for n in _notas(db, None, None):
        base = cfg["XML_DIR"] / f"{(n['dh_emissao'] or n['dh_autorizacao'] or 'sem-data')[:7]}"
        for sufixo, xml in (("procNFe", n["xml_proc"]), ("procEventoCancelamento", n["cancel_xml"])):
            if not xml:
                continue
            alvo = base / f"{n['chave']}-{sufixo}.xml"
            if not alvo.exists():
                base.mkdir(parents=True, exist_ok=True)
                alvo.write_text(xml, encoding="utf-8")
                refeitos += 1
    return refeitos

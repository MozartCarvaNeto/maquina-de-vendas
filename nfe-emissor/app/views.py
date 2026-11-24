"""Rotas da aplicação web."""
import io
import re
import zipfile
from urllib.parse import urlparse
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

import requests
from flask import (Blueprint, Response, abort, current_app, flash, g, jsonify, redirect,
                   render_template, request, session, url_for)

from . import security, servico, tenant
from .integracoes import PLATAFORMAS, ErroIntegracao, importador
from .integracoes import mercadolivre as ml
from . import logo
from .db import get_db
from .nfe import tabelas as T
from .nfe import tls
from .nfe.danfe import gerar_danfe
from .nfe.sefaz_urls import SERVICOS, VERIFICADOS, autorizador_da_uf, listar_urls
from .nfe.sefaz_urls import padrao as sefaz_padrao
from .nfe.util import (limpar_texto, normalizar_cnpj, parse_decimal, so_digitos, validar_cnpj,
                       validar_documento)
from .nfe.xml_builder import DadosInvalidos
from .security import login_required

bp = Blueprint("main", __name__)

AUTORIZADORES_OPCOES = ["", "SP", "MG", "PR", "RS", "BA", "GO", "PE", "AM", "CE", "MS", "MT",
                        "SVRS", "SVAN"]


# ----------------------------------------------------------------------------------------
# Utilidades
# ----------------------------------------------------------------------------------------
def _f(nome: str) -> str:
    return request.form.get(nome, "").strip()


def _dec(nome: str, rotulo: str, erros: list, padrao: str = "0", minimo=0) -> str:
    try:
        v = parse_decimal(_f(nome) or padrao)
        if v < minimo:
            erros.append(f"{rotulo}: valor não pode ser negativo.")
        return format(v, "f")
    except ValueError:
        erros.append(f"{rotulo}: número inválido.")
        return padrao


def _flash_erros(erros):
    for e in erros:
        flash(e, "erro")


@bp.app_context_processor
def contexto_global():
    ambiente = None
    cota = None
    if getattr(g, "conta", None):
        db = get_db()
        row = db.execute("SELECT ambiente FROM empresa WHERE id = 1").fetchone()
        ambiente = row["ambiente"] if row else None
        cota = tenant.uso(db)
    return {"T": T, "NOTA_STATUS": T.NOTA_STATUS, "ambiente_atual": ambiente, "cota": cota,
            "somente_leitura": getattr(g, "somente_leitura", False)}


@bp.app_template_filter("brl")
def filtro_brl(valor, casas=2):
    try:
        texto = f"{Decimal(str(valor)):,.{int(casas)}f}"
    except (InvalidOperation, ValueError):
        return str(valor)
    return texto.replace(",", "X").replace(".", ",").replace("X", ".")


@bp.app_template_filter("data_br")
def filtro_data_br(iso, com_hora=True):
    if not iso:
        return ""
    try:
        d = datetime.fromisoformat(str(iso))
    except ValueError:
        return str(iso)
    return d.strftime("%d/%m/%Y %H:%M" if com_hora else "%d/%m/%Y")


@bp.app_errorhandler(400)
@bp.app_errorhandler(404)
@bp.app_errorhandler(413)
@bp.app_errorhandler(500)
def erro_http(e):
    codigo = getattr(e, "code", 500)
    mensagem = {404: "Página não encontrada.", 413: "Arquivo grande demais (máximo 2 MB)."}.get(
        codigo, getattr(e, "description", None) or "Erro inesperado.")
    if codigo == 500:
        mensagem = "Erro interno. Veja os logs do servidor."
    return render_template("erro.html", codigo=codigo, mensagem=mensagem), codigo


@bp.get("/healthz")
def healthz():
    return {"ok": True}


@bp.get("/_uso")
def uso_json():
    """Uso do mês (consultado pelo Turbo Prospect na tela do plano)."""
    return jsonify(tenant.uso(get_db()))


@bp.route("/login", methods=["GET", "POST"])
@bp.post("/logout")
def sem_login():
    """O login é o do Turbo Prospect."""
    return redirect(url_for("main.index"))


# ----------------------------------------------------------------------------------------
# Painel
# ----------------------------------------------------------------------------------------
@bp.get("/")
@login_required
def index():
    db = get_db()
    empresa = servico.carregar_empresa(db)
    avisos = []
    obrigatorios = ["cnpj", "razao_social", "ie", "logradouro", "numero", "bairro",
                    "cod_municipio", "municipio", "uf", "cep"]
    if any(not (empresa.get(c) or "").strip() for c in obrigatorios):
        avisos.append(("Complete os dados da empresa em Configurações.", "main.empresa_form"))
    if not empresa["cert_arquivo"]:
        avisos.append(("Envie o certificado digital A1.", "main.empresa_form"))
    elif empresa["cert_validade"]:
        validade = datetime.fromisoformat(empresa["cert_validade"])
        dias = (validade - datetime.now(timezone.utc)).days
        if dias < 0:
            avisos.append(("O certificado digital está vencido.", "main.empresa_form"))
        elif dias <= 30:
            avisos.append((f"O certificado digital vence em {dias} dia(s).", "main.empresa_form"))
    contagem = {r["status"]: r["n"] for r in db.execute(
        "SELECT status, COUNT(*) n FROM notas WHERE ambiente = ? OR ambiente IS NULL GROUP BY status",
        (empresa["ambiente"],))}
    ultimas = db.execute(
        "SELECT n.*, c.nome cliente_nome FROM notas n LEFT JOIN clientes c ON c.id = n.cliente_id "
        "ORDER BY n.id DESC LIMIT 8").fetchall()
    return render_template("index.html", empresa=empresa, avisos=avisos, contagem=contagem,
                           ultimas=ultimas)


# ----------------------------------------------------------------------------------------
# Empresa e certificado
# ----------------------------------------------------------------------------------------
@bp.get("/empresa")
@login_required
def empresa_legado():
    return redirect(url_for("main.empresa_form"))


def _produtos_incompativeis(db, crt: str) -> int:
    """Produtos ativos cujo CSOSN/CST não existe no regime informado."""
    validos = [c for c, _ in (T.ICMS_SIMPLES if crt in ("1", "2") else T.ICMS_NORMAL)]
    marcas = ",".join("?" * len(validos))
    return db.execute(f"SELECT COUNT(*) n FROM produtos WHERE ativo = 1 AND cst_icms NOT IN ({marcas})",
                      validos).fetchone()["n"]


@bp.get("/configuracoes")
@login_required
def empresa_form():
    db = get_db()
    empresa = servico.carregar_empresa(db)
    autorizador = empresa["autorizador"] or autorizador_da_uf(empresa["uf"] or "")
    personalizadas = servico.urls_personalizadas(db, tenant.cfg())
    urls = {amb: listar_urls(autorizador, amb, personalizadas) for amb in ("1", "2")}
    alteradas = {amb: {s for s, u in urls[amb].items() if u != sefaz_padrao(autorizador, amb).get(s, "")}
                 for amb in ("1", "2")}
    return render_template(
        "empresa.html", e=empresa, autorizadores=AUTORIZADORES_OPCOES,
        autorizador_efetivo=autorizador, url_verificada=autorizador in VERIFICADOS,
        url_cadastrada=all(urls["2"].values()) and all(urls["1"].values()),
        urls=urls, alteradas=alteradas, servicos=SERVICOS,
        cadeia_ok=tls.tem_cadeia(current_app.config["DATA_DIR"]),
        ultimo=servico.ultimo_numero(db, empresa["ambiente"], empresa["serie"]),
        tem_logo=logo.existe(), logo_versao=logo.versao())


@bp.post("/configuracoes/sefaz")
@login_required
def configuracoes_sefaz():
    """Salva endereços da SEFAZ alterados (vazio ou igual ao de fábrica = volta ao padrão)."""
    db = get_db()
    empresa = servico.carregar_empresa(db)
    aut = empresa["autorizador"] or autorizador_da_uf(empresa["uf"] or "")
    erros, gravar, apagar = [], [], []
    for amb in ("1", "2"):
        de_fabrica = sefaz_padrao(aut, amb)
        for srv in SERVICOS:
            valor = _f(f"url_{amb}_{srv}")
            if not valor or valor == de_fabrica.get(srv):
                apagar.append((aut, amb, srv))
                continue
            p = urlparse(valor)
            if p.scheme != "https" or not p.hostname or not p.hostname.endswith(".gov.br"):
                erros.append(f"{srv} (ambiente {amb}): informe um endereço https de um site .gov.br "
                             "(o certificado digital só deve ser apresentado à SEFAZ).")
            else:
                gravar.append((aut, amb, srv, valor))
    if erros:
        _flash_erros(erros)
        return redirect(url_for("main.empresa_form") + "#sefaz")
    db.executemany("DELETE FROM sefaz_urls WHERE autorizador = ? AND ambiente = ? AND servico = ?", apagar)
    db.executemany("INSERT INTO sefaz_urls (autorizador, ambiente, servico, url) VALUES (?, ?, ?, ?) "
                   "ON CONFLICT (autorizador, ambiente, servico) DO UPDATE SET url = excluded.url", gravar)
    db.commit()
    flash("Endereços da SEFAZ salvos. Use \"Testar conexão\" para conferir.", "ok")
    return redirect(url_for("main.empresa_form") + "#sefaz")


@bp.post("/configuracoes")
@login_required
def empresa_salvar():
    db = get_db()
    atual = servico.carregar_empresa(db)
    erros = []
    cnpj = normalizar_cnpj(_f("cnpj"))
    if not validar_cnpj(cnpj):
        erros.append("CNPJ inválido.")
    uf = _f("uf").upper()
    if uf not in T.UF_CODIGO:
        erros.append("Selecione a UF.")
    if _f("crt") not in ("1", "2", "3"):
        erros.append("Selecione o regime tributário.")
    if not _f("razao_social"):
        erros.append("Informe a razão social.")
    if len(so_digitos(_f("cod_municipio"))) != 7:
        erros.append("O código do município (IBGE) deve ter 7 dígitos.")
    if len(so_digitos(_f("cep"))) != 8:
        erros.append("O CEP deve ter 8 dígitos.")
    if not so_digitos(_f("ie")):
        erros.append("Informe a Inscrição Estadual (somente números).")
    ambiente = _f("ambiente") if _f("ambiente") in ("1", "2") else "2"
    if ambiente == "1" and atual["ambiente"] != "1" and not request.form.get("confirmar_producao"):
        erros.append("Para ativar a PRODUÇÃO marque a confirmação: notas emitidas têm valor fiscal.")
    serie = so_digitos(_f("serie")) or "1"
    if not 1 <= int(serie) <= 999:
        erros.append("Série deve estar entre 1 e 999.")
    ultimo = None
    if _f("ultimo_numero") != "":
        if not _f("ultimo_numero").isdigit():
            erros.append("Último número emitido deve ser um número inteiro.")
        else:
            ultimo = int(_f("ultimo_numero"))
    if erros:
        _flash_erros(erros)
        return redirect(url_for("main.empresa_form"))

    autorizador = _f("autorizador")
    if autorizador not in AUTORIZADORES_OPCOES:
        autorizador = ""
    db.execute(
        "UPDATE empresa SET cnpj=?, razao_social=?, nome_fantasia=?, ie=?, im=?, cnae=?, crt=?, "
        "logradouro=?, numero=?, complemento=?, bairro=?, cod_municipio=?, municipio=?, uf=?, "
        "cep=?, fone=?, email=?, ambiente=?, serie=?, autorizador=?, nat_op_padrao=?, "
        "resp_tec_cnpj=?, resp_tec_contato=?, resp_tec_email=?, resp_tec_fone=? WHERE id=1",
        (cnpj, limpar_texto(_f("razao_social"), 60), limpar_texto(_f("nome_fantasia"), 60),
         so_digitos(_f("ie")), so_digitos(_f("im")), so_digitos(_f("cnae")), _f("crt"),
         limpar_texto(_f("logradouro"), 60), limpar_texto(_f("numero"), 60),
         limpar_texto(_f("complemento"), 60), limpar_texto(_f("bairro"), 60),
         so_digitos(_f("cod_municipio")), limpar_texto(_f("municipio"), 60), uf,
         so_digitos(_f("cep")), so_digitos(_f("fone")), limpar_texto(_f("email"), 60), ambiente,
         serie, autorizador, limpar_texto(_f("nat_op_padrao"), 60) or "VENDA DE MERCADORIA",
         normalizar_cnpj(_f("resp_tec_cnpj")), limpar_texto(_f("resp_tec_contato"), 60),
         limpar_texto(_f("resp_tec_email"), 60), so_digitos(_f("resp_tec_fone"))))
    db.commit()
    if ultimo is not None:
        servico.definir_ultimo_numero(db, ambiente, serie, ultimo)
    flash("Configurações salvas.", "ok")
    novo_crt = _f("crt")
    if novo_crt != atual["crt"]:
        nomes = dict(T.CRT)
        flash(f"Regime tributário alterado para: {nomes[novo_crt]}. Rascunhos já salvos guardam os dados "
              "fiscais dos produtos da época: abra e salve de novo para atualizar.", "aviso")
        n = _produtos_incompativeis(db, novo_crt)
        if n:
            tipo = "CSOSN" if novo_crt in ("1", "2") else "CST"
            flash(f"{n} produto(s) ativo(s) têm {tipo} do ICMS incompatível com o novo regime. "
                  "Edite-os em Produtos antes de emitir.", "erro")
        if novo_crt == "3":
            flash("Atenção: no regime normal este sistema cobre só o básico (CST 00/40/41/50). "
                  "ST, DIFAL e IPI não estão implementados.", "aviso")
    return redirect(url_for("main.empresa_form"))


@bp.post("/configuracoes/certificado")
@login_required
def empresa_certificado():
    db = get_db()
    empresa = servico.carregar_empresa(db)
    arquivo = request.files.get("certificado")
    senha = request.form.get("senha_certificado", "")
    if not arquivo or not arquivo.filename or not senha:
        flash("Escolha o arquivo do certificado (.pfx/.p12) e informe a senha.", "erro")
        return redirect(url_for("main.empresa_form"))
    try:
        cert = servico.validar_certificado_upload(arquivo.read(), senha, empresa)
    except servico.ErroNegocio as exc:
        flash(str(exc), "erro")
        return redirect(url_for("main.empresa_form"))
    # grava o .pfx original (já protegido pela senha) e a senha criptografada
    import os
    destino = tenant.cfg()["CERT_DIR"] / "empresa.pfx"
    arquivo.stream.seek(0)
    destino.write_bytes(arquivo.read())
    os.chmod(destino, 0o600)
    db.execute("UPDATE empresa SET cert_arquivo=?, cert_senha_enc=?, cert_titular=?, cert_cnpj=?, "
               "cert_validade=? WHERE id=1",
               ("empresa.pfx", security.cifrar(senha), cert.titular, cert.cnpj or "",
                cert.validade_fim.isoformat()))
    db.commit()
    flash(f"Certificado salvo: {cert.titular} (válido até {cert.validade_fim:%d/%m/%Y}).", "ok")
    return redirect(url_for("main.empresa_form"))


# ----------------------------------------------------------------------------------------
# Logotipo impresso no DANFE (um por conta)
# ----------------------------------------------------------------------------------------
@bp.get("/configuracoes/logo.png")
@login_required
def logo_imagem():
    dados = logo.ler()
    if not dados:
        abort(404)
    return Response(dados, mimetype="image/png", headers={"Cache-Control": "private, no-cache"})


@bp.post("/configuracoes/logo")
@login_required
def logo_enviar():
    arquivo = request.files.get("logo")
    if not arquivo or not arquivo.filename:
        flash("Escolha uma imagem (PNG, JPG ou WEBP).", "erro")
        return redirect(url_for("main.empresa_form") + "#logotipo")
    try:
        logo.salvar(arquivo.read(logo.TAMANHO_MAX + 1))
    except logo.LogoInvalido as exc:
        flash(str(exc), "erro")
    else:
        flash("Logotipo salvo. Ele passa a sair no topo do DANFE.", "ok")
    return redirect(url_for("main.empresa_form") + "#logotipo")


@bp.post("/configuracoes/logo/remover")
@login_required
def logo_remover():
    logo.remover()
    flash("Logotipo removido. O DANFE volta ao formato sem logotipo.", "ok")
    return redirect(url_for("main.empresa_form") + "#logotipo")


@bp.post("/configuracoes/cadeia")
@login_required
def empresa_cadeia():
    """Instala a cadeia de certificados ICP-Brasil: baixa do ITI ou usa o arquivo enviado."""
    pasta = current_app.config["DATA_DIR"]
    arquivo = request.files.get("cadeia")
    try:
        if arquivo and arquivo.filename:
            n = tls.salvar_cadeia(pasta, tls.extrair_certificados(arquivo.read(), arquivo.filename))
        else:
            n = tls.baixar_cadeia(pasta)
        flash(f"Cadeia ICP-Brasil instalada ({n} certificados). Agora use \"Testar conexão\".", "ok")
    except tls.CadeiaErro as exc:
        flash(str(exc), "erro")
    return redirect(url_for("main.empresa_form") + "#certificado")


@bp.post("/configuracoes/testar")
@login_required
def empresa_testar():
    try:
        r = servico.testar_conexao(get_db(), tenant.cfg())
        categoria = "ok" if r["cstat"] == "107" else "aviso"
        flash(f"SEFAZ ({r['autorizador']}) respondeu: {r['cstat']} - {r['xmotivo']}", categoria)
    except servico.ErroNegocio as exc:
        flash(str(exc), "erro")
    return redirect(url_for("main.empresa_form"))


# ----------------------------------------------------------------------------------------
# CEP (preenche endereço e código IBGE do município)
# ----------------------------------------------------------------------------------------
@bp.get("/api/cep/<cep>")
@login_required
def api_cep(cep):
    cep = so_digitos(cep)
    if len(cep) != 8:
        return jsonify(erro="CEP inválido."), 400
    try:
        dados = requests.get(f"https://viacep.com.br/ws/{cep}/json/", timeout=5).json()
    except Exception:
        return jsonify(erro="Não foi possível consultar o CEP agora."), 502
    if dados.get("erro"):
        return jsonify(erro="CEP não encontrado."), 404
    return jsonify(logradouro=dados.get("logradouro", ""), bairro=dados.get("bairro", ""),
                   municipio=dados.get("localidade", ""), uf=dados.get("uf", ""),
                   cod_municipio=dados.get("ibge", ""))


# ----------------------------------------------------------------------------------------
# Produtos
# ----------------------------------------------------------------------------------------
@bp.get("/produtos")
@login_required
def produtos():
    q = request.args.get("q", "").strip()
    sql, args = "SELECT * FROM produtos", []
    if q:
        sql += " WHERE codigo LIKE ? OR descricao LIKE ? OR ncm LIKE ?"
        args = [f"%{q}%"] * 3
    sql += " ORDER BY ativo DESC, descricao LIMIT 500"
    return render_template("produtos.html", produtos=get_db().execute(sql, args).fetchall(), q=q)


def _ler_produto():
    erros = []
    crt = servico.carregar_empresa(get_db())["crt"]
    d = {
        "codigo": limpar_texto(_f("codigo"), 60), "descricao": limpar_texto(_f("descricao"), 120),
        "ncm": so_digitos(_f("ncm")), "cest": so_digitos(_f("cest")), "ean": so_digitos(_f("ean")),
        "unidade": limpar_texto(_f("unidade"), 6).upper() or "UN", "origem": _f("origem") or "0",
        "cfop": so_digitos(_f("cfop")), "cst_icms": _f("cst_icms"),
        "cst_pis": _f("cst_pis") or "49", "cst_cofins": _f("cst_cofins") or "49",
    }
    d["preco"] = _dec("preco", "Preço", erros)
    d["aliq_icms"] = _dec("aliq_icms", "Alíquota ICMS", erros)
    d["aliq_pis"] = _dec("aliq_pis", "Alíquota PIS", erros)
    d["aliq_cofins"] = _dec("aliq_cofins", "Alíquota COFINS", erros)
    if not d["codigo"]:
        erros.append("Informe o código (SKU).")
    if not d["descricao"]:
        erros.append("Informe a descrição.")
    if len(d["ncm"]) != 8:
        erros.append("NCM deve ter 8 dígitos.")
    if d["cest"] and len(d["cest"]) != 7:
        erros.append("CEST deve ter 7 dígitos (ou ficar vazio).")
    if d["ean"] and len(d["ean"]) not in (8, 12, 13, 14):
        erros.append("GTIN/EAN deve ter 8, 12, 13 ou 14 dígitos (ou ficar vazio).")
    if len(d["cfop"]) != 4:
        erros.append("CFOP deve ter 4 dígitos.")
    validos = [c for c, _ in (T.ICMS_SIMPLES if crt in ("1", "2") else T.ICMS_NORMAL)]
    if d["cst_icms"] not in validos:
        erros.append(f"CST/CSOSN do ICMS deve ser um de: {', '.join(validos)}.")
    return d, erros


@bp.route("/produtos/novo", methods=["GET", "POST"])
@bp.route("/produtos/<int:pid>", methods=["GET", "POST"])
@login_required
def produto_form(pid=None):
    db = get_db()
    empresa = servico.carregar_empresa(db)
    atual = None
    if pid:
        atual = db.execute("SELECT * FROM produtos WHERE id = ?", (pid,)).fetchone()
        if atual is None:
            abort(404)
    if request.method == "POST":
        d, erros = _ler_produto()
        if not erros:
            dup = db.execute("SELECT id FROM produtos WHERE codigo = ? AND id != ?",
                             (d["codigo"], pid or 0)).fetchone()
            if dup:
                erros.append("Já existe um produto com este código.")
        if erros:
            _flash_erros(erros)
            return render_template("produto_form.html", p=d, pid=pid, crt=empresa["crt"])
        cols = list(d)
        if pid:
            db.execute(f"UPDATE produtos SET {', '.join(c + '=?' for c in cols)} WHERE id=?",
                       [*d.values(), pid])
        else:
            db.execute(f"INSERT INTO produtos ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                       list(d.values()))
        db.commit()
        flash("Produto salvo.", "ok")
        return redirect(url_for("main.produtos"))
    padrao = dict(atual) if atual else {
        "unidade": "UN", "origem": "0", "cfop": "5102", "cst_pis": "49", "cst_cofins": "49",
        "cst_icms": "102" if empresa["crt"] in ("1", "2") else "00", "aliq_icms": "0",
        "aliq_pis": "0", "aliq_cofins": "0", "preco": "0.00"}
    return render_template("produto_form.html", p=padrao, pid=pid, crt=empresa["crt"])


@bp.post("/produtos/<int:pid>/ativo")
@login_required
def produto_ativo(pid):
    db = get_db()
    db.execute("UPDATE produtos SET ativo = 1 - ativo WHERE id = ?", (pid,))
    db.commit()
    return redirect(url_for("main.produtos"))


# ----------------------------------------------------------------------------------------
# Clientes
# ----------------------------------------------------------------------------------------
@bp.get("/clientes")
@login_required
def clientes():
    q = request.args.get("q", "").strip()
    sql, args = "SELECT * FROM clientes", []
    if q:
        sql += " WHERE nome LIKE ? OR documento LIKE ?"
        args = [f"%{q}%", f"%{so_digitos(q) or q}%"]
    sql += " ORDER BY nome LIMIT 500"
    return render_template("clientes.html", clientes=get_db().execute(sql, args).fetchall(), q=q)


@bp.route("/clientes/novo", methods=["GET", "POST"])
@bp.route("/clientes/<int:cid>", methods=["GET", "POST"])
@login_required
def cliente_form(cid=None):
    db = get_db()
    atual = None
    if cid:
        atual = db.execute("SELECT * FROM clientes WHERE id = ?", (cid,)).fetchone()
        if atual is None:
            abort(404)
    if request.method == "POST":
        erros = []
        d = {
            "documento": normalizar_cnpj(_f("documento")), "nome": limpar_texto(_f("nome"), 60),
            "ind_ie_dest": _f("ind_ie_dest") if _f("ind_ie_dest") in ("1", "2", "9") else "9",
            "ie": so_digitos(_f("ie")), "email": limpar_texto(_f("email"), 60),
            "fone": so_digitos(_f("fone")), "logradouro": limpar_texto(_f("logradouro"), 60),
            "numero": limpar_texto(_f("numero"), 60), "complemento": limpar_texto(_f("complemento"), 60),
            "bairro": limpar_texto(_f("bairro"), 60), "cod_municipio": so_digitos(_f("cod_municipio")),
            "municipio": limpar_texto(_f("municipio"), 60), "uf": _f("uf").upper(),
            "cep": so_digitos(_f("cep")),
        }
        if not validar_documento(d["documento"]):
            erros.append("CPF/CNPJ inválido.")
        if not d["nome"]:
            erros.append("Informe o nome.")
        for campo, rotulo in [("logradouro", "logradouro"), ("numero", "número"),
                              ("bairro", "bairro"), ("municipio", "município")]:
            if not d[campo]:
                erros.append(f"Informe o {rotulo}.")
        if len(d["cod_municipio"]) != 7:
            erros.append("Código do município (IBGE) deve ter 7 dígitos (use o botão de buscar CEP).")
        if len(d["cep"]) != 8:
            erros.append("CEP deve ter 8 dígitos.")
        if d["uf"] not in T.UF_CODIGO:
            erros.append("Selecione a UF.")
        if d["ind_ie_dest"] == "1" and not d["ie"]:
            erros.append("Contribuinte do ICMS precisa de Inscrição Estadual.")
        if d["email"] and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", d["email"]):
            erros.append("E-mail inválido.")
        if erros:
            _flash_erros(erros)
            return render_template("cliente_form.html", c=d, cid=cid)
        cols = list(d)
        if cid:
            db.execute(f"UPDATE clientes SET {', '.join(c + '=?' for c in cols)} WHERE id=?",
                       [*d.values(), cid])
        else:
            db.execute(f"INSERT INTO clientes ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                       list(d.values()))
        db.commit()
        flash("Cliente salvo.", "ok")
        return redirect(url_for("main.clientes"))
    padrao = dict(atual) if atual else {"ind_ie_dest": "9"}
    return render_template("cliente_form.html", c=padrao, cid=cid)


# ----------------------------------------------------------------------------------------
# Notas fiscais
# ----------------------------------------------------------------------------------------
@bp.get("/notas")
@login_required
def notas():
    status = request.args.get("status", "")
    q = request.args.get("q", "").strip()
    sql = ("SELECT n.*, c.nome cliente_nome FROM notas n LEFT JOIN clientes c ON c.id = n.cliente_id "
           "WHERE 1=1")
    args = []
    if status in T.NOTA_STATUS:
        sql += " AND n.status = ?"
        args.append(status)
    if q:
        sql += " AND (c.nome LIKE ? OR CAST(n.numero AS TEXT) = ? OR n.chave LIKE ?)"
        args += [f"%{q}%", q, f"%{q}%"]
    sql += " ORDER BY n.id DESC LIMIT 300"
    return render_template("notas.html", notas=get_db().execute(sql, args).fetchall(),
                           status=status, q=q)


def _ler_nota_form(db):
    erros = []
    d = {
        "cliente_id": int(_f("cliente_id")) if _f("cliente_id").isdigit() else None,
        "nat_op": limpar_texto(_f("nat_op"), 60) or "VENDA DE MERCADORIA",
        "ind_final": _f("ind_final") if _f("ind_final") in ("0", "1") else "1",
        "ind_pres": _f("ind_pres") or "2",
        "ind_intermed": "1" if _f("ind_intermed") == "1" else "0",
        "intermed_cnpj": normalizar_cnpj(_f("intermed_cnpj")),
        "intermed_id": limpar_texto(_f("intermed_id"), 60),
        "mod_frete": _f("mod_frete") or "9", "forma_pagto": _f("forma_pagto") or "99",
        "info_adicional": limpar_texto(_f("info_adicional"), 2000),
    }
    d["valor_frete"] = _dec("valor_frete", "Frete", erros, "0")
    d["valor_desconto"] = _dec("valor_desconto", "Desconto", erros, "0")
    d["valor_outras"] = _dec("valor_outras", "Outras despesas", erros, "0")
    if not d["cliente_id"] or not db.execute("SELECT 1 FROM clientes WHERE id = ?",
                                              (d["cliente_id"],)).fetchone():
        erros.append("Selecione o cliente.")
    if d["ind_intermed"] == "1" and (not validar_cnpj(d["intermed_cnpj"]) or not d["intermed_id"]):
        erros.append("Intermediador: informe CNPJ válido e o identificador cadastrado no intermediador.")

    itens = []
    for pid, qtd, vun in zip(request.form.getlist("produto_id"), request.form.getlist("quantidade"),
                              request.form.getlist("valor_unitario")):
        if not pid.strip():
            continue
        prod = db.execute("SELECT * FROM produtos WHERE id = ?", (pid,)).fetchone() if pid.isdigit() else None
        if prod is None:
            erros.append("Produto não encontrado em um dos itens.")
            continue
        try:
            q, v = parse_decimal(qtd), parse_decimal(vun)
            if q is None or q <= 0:
                erros.append(f"{prod['codigo']}: quantidade deve ser maior que zero.")
            if v is None or v < 0:
                erros.append(f"{prod['codigo']}: valor unitário inválido.")
        except ValueError:
            erros.append(f"{prod['codigo']}: quantidade ou valor inválido.")
            continue
        itens.append({
            "produto_id": prod["id"], "codigo": prod["codigo"], "descricao": prod["descricao"],
            "ncm": prod["ncm"], "cest": prod["cest"], "ean": prod["ean"], "cfop": prod["cfop"],
            "unidade": prod["unidade"], "quantidade": format(q, "f"), "valor_unitario": format(v, "f"),
            "origem": prod["origem"], "cst_icms": prod["cst_icms"], "aliq_icms": prod["aliq_icms"],
            "cst_pis": prod["cst_pis"], "aliq_pis": prod["aliq_pis"],
            "cst_cofins": prod["cst_cofins"], "aliq_cofins": prod["aliq_cofins"]})
    if not itens:
        erros.append("Adicione ao menos um item.")
    return d, itens, erros


def _salvar_nota(db, nota_id, d, itens):
    d["total_nf"] = servico.total_nota(itens, d["valor_frete"], d["valor_outras"], d["valor_desconto"])
    if nota_id:
        cols = list(d)
        db.execute(f"UPDATE notas SET {', '.join(c + '=?' for c in cols)} WHERE id=?",
                   [*d.values(), nota_id])
        db.execute("DELETE FROM nota_itens WHERE nota_id = ?", (nota_id,))
    else:
        cols = list(d)
        cur = db.execute(f"INSERT INTO notas ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                         list(d.values()))
        nota_id = cur.lastrowid
    for ordem, it in enumerate(itens, start=1):
        cols = ["nota_id", "ordem", *it]
        db.execute(f"INSERT INTO nota_itens ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                   [nota_id, ordem, *it.values()])
    db.commit()
    return nota_id


@bp.route("/notas/nova", methods=["GET", "POST"])
@bp.route("/notas/<int:nota_id>/editar", methods=["GET", "POST"])
@login_required
def nota_form(nota_id=None):
    db = get_db()
    empresa = servico.carregar_empresa(db)
    clientes_ = db.execute("SELECT id, nome, documento FROM clientes ORDER BY nome").fetchall()
    produtos_ = db.execute("SELECT * FROM produtos ORDER BY ativo DESC, descricao").fetchall()

    if nota_id:
        nota, _cli, itens = servico.carregar_nota(db, nota_id)
        if nota["status"] not in ("rascunho", "rejeitada"):
            flash("Só é possível editar rascunhos e notas rejeitadas.", "erro")
            return redirect(url_for("main.nota", nota_id=nota_id))
    else:
        nota, itens = None, []
        origem = request.args.get("duplicar", "")
        if origem.isdigit():
            try:
                nota, _cli, itens = servico.carregar_nota(db, int(origem))
                nota["id"] = None
            except servico.ErroNegocio:
                nota, itens = None, []

    if request.method == "POST":
        d, novos_itens, erros = _ler_nota_form(db)
        if erros:
            _flash_erros(erros)
            nota = {**(nota or {}), **d, "id": nota_id}
            return render_template("nota_form.html", nota=nota, itens=novos_itens, clientes=clientes_,
                                   produtos=produtos_, empresa=empresa)
        nota_id = _salvar_nota(db, nota_id, d, novos_itens)
        flash("Nota salva como rascunho. Revise e clique em Emitir.", "ok")
        return redirect(url_for("main.nota", nota_id=nota_id))

    if nota is None:
        nota = {"nat_op": empresa["nat_op_padrao"] or "VENDA DE MERCADORIA", "ind_final": "1",
                "ind_pres": "2", "ind_intermed": "0", "mod_frete": "9", "forma_pagto": "17",
                "valor_frete": "0.00", "valor_desconto": "0.00", "valor_outras": "0.00"}
    return render_template("nota_form.html", nota=nota, itens=itens, clientes=clientes_,
                           produtos=produtos_, empresa=empresa)


@bp.get("/notas/<int:nota_id>")
@login_required
def nota(nota_id):
    try:
        n, cliente, itens = servico.carregar_nota(get_db(), nota_id)
    except servico.ErroNegocio:
        abort(404)
    return render_template("nota.html", n=n, cliente=cliente, itens=itens)


def _acao(nota_id, funcao):
    try:
        return funcao()
    except DadosInvalidos as exc:
        for e in exc.erros:
            flash(e, "erro")
    except servico.ErroNegocio as exc:
        flash(str(exc), "erro")
    return None


@bp.post("/notas/<int:nota_id>/emitir")
@login_required
def nota_emitir(nota_id):
    db = get_db()
    erro_cota = tenant.erro_de_cota(db, servico.carregar_empresa(db)["ambiente"])
    if erro_cota:
        flash(erro_cota, "erro")
        return redirect(url_for("main.nota", nota_id=nota_id))
    r = _acao(nota_id, lambda: servico.emitir(get_db(), tenant.cfg(), nota_id))
    if r:
        if r["status"] == "autorizada":
            flash(f"NF-e autorizada! Protocolo {r['protocolo']}.", "ok")
        else:
            flash(f"{r['status'].capitalize()}: {r['cstat']} - {r['xmotivo']}", "erro")
    return redirect(url_for("main.nota", nota_id=nota_id))


@bp.post("/notas/<int:nota_id>/consultar")
@login_required
def nota_consultar(nota_id):
    r = _acao(nota_id, lambda: servico.consultar(get_db(), tenant.cfg(), nota_id))
    if r:
        flash(f"SEFAZ: {r['cstat']} - {r['xmotivo']}", "ok" if r["status"] == "autorizada" else "aviso")
    return redirect(url_for("main.nota", nota_id=nota_id))


@bp.post("/notas/<int:nota_id>/cancelar")
@login_required
def nota_cancelar(nota_id):
    r = _acao(nota_id, lambda: servico.cancelar(get_db(), tenant.cfg(), nota_id,
                                                _f("justificativa")))
    if r:
        if r["cancelada"]:
            flash(f"NF-e cancelada. Protocolo do evento {r['protocolo']}.", "ok")
        else:
            flash(f"Cancelamento não aceito: {r['cstat']} - {r['xmotivo']}", "erro")
    return redirect(url_for("main.nota", nota_id=nota_id))


@bp.post("/notas/<int:nota_id>/excluir")
@login_required
def nota_excluir(nota_id):
    db = get_db()
    n = db.execute("SELECT status, chave FROM notas WHERE id = ?", (nota_id,)).fetchone()
    if n is None:
        abort(404)
    if n["status"] != "rascunho":
        flash("Só é possível excluir rascunhos (notas já enviadas fazem parte da escrituração).", "erro")
        return redirect(url_for("main.nota", nota_id=nota_id))
    db.execute("DELETE FROM notas WHERE id = ?", (nota_id,))
    db.commit()
    flash("Rascunho excluído.", "ok")
    return redirect(url_for("main.notas"))


def _nota_xml(nota_id):
    n = get_db().execute("SELECT * FROM notas WHERE id = ?", (nota_id,)).fetchone()
    if n is None:
        abort(404)
    return n


@bp.get("/notas/<int:nota_id>/xml")
@login_required
def nota_xml(nota_id):
    n = _nota_xml(nota_id)
    xml = n["xml_proc"] or n["xml_assinado"]
    if not xml:
        abort(404, "Esta nota ainda não possui XML.")
    sufixo = "procNFe" if n["xml_proc"] else "nfe-nao-autorizada"
    return Response(xml, mimetype="application/xml",
                    headers={"Content-Disposition": f'attachment; filename="{n["chave"]}-{sufixo}.xml"'})


@bp.get("/notas/<int:nota_id>/xml-cancelamento")
@login_required
def nota_xml_cancelamento(nota_id):
    n = _nota_xml(nota_id)
    if not n["cancel_xml"]:
        abort(404, "Esta nota não possui evento de cancelamento.")
    return Response(n["cancel_xml"], mimetype="application/xml",
                    headers={"Content-Disposition": f'attachment; filename="{n["chave"]}-cancelamento.xml"'})


@bp.get("/notas/<int:nota_id>/danfe.pdf")
@login_required
def nota_danfe(nota_id):
    n = _nota_xml(nota_id)
    xml = n["xml_proc"] or n["xml_assinado"]
    if not xml:
        abort(404, "Emita a nota para gerar o DANFE.")
    pdf = gerar_danfe(xml, cancelada=n["status"] == "cancelada", logo=logo.ler())
    return Response(pdf, mimetype="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="danfe-{n["numero"]}.pdf"'})


@bp.get("/notas/exportar")
@login_required
def notas_exportar():
    """ZIP com os XMLs autorizados (e cancelamentos) de um mês - é o que o contador pede."""
    mes = request.args.get("mes", "")
    ambiente = request.args.get("ambiente", "1")
    if not re.fullmatch(r"\d{4}-\d{2}", mes) or ambiente not in ("1", "2"):
        abort(400, "Informe o mês no formato AAAA-MM.")
    linhas = get_db().execute(
        "SELECT * FROM notas WHERE ambiente = ? AND status IN ('autorizada', 'cancelada') "
        "AND substr(dh_emissao, 1, 7) = ? ORDER BY numero", (ambiente, mes)).fetchall()
    if not linhas:
        flash("Nenhuma nota autorizada nesse mês/ambiente.", "aviso")
        return redirect(url_for("main.notas"))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for n in linhas:
            if n["xml_proc"]:
                z.writestr(f"{n['chave']}-procNFe.xml", n["xml_proc"])
            if n["cancel_xml"]:
                z.writestr(f"{n['chave']}-cancelamento.xml", n["cancel_xml"])
    return Response(buf.getvalue(), mimetype="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="xmls-{mes}.zip"'})


# ----------------------------------------------------------------------------------------
# Integrações com lojas virtuais
# ----------------------------------------------------------------------------------------
def _plataforma(nome):
    if nome not in PLATAFORMAS:
        abort(404)
    return PLATAFORMAS[nome]


def _redirect_ml():
    return url_for("main.integracao_ml_retorno", _external=True)


@bp.get("/integracoes")
@login_required
def integracoes():
    db = get_db()
    cartoes = []
    for chave, mod in PLATAFORMAS.items():
        cfg = importador.carregar_config(db, chave)
        row = db.execute("SELECT ultima_importacao FROM integracoes WHERE plataforma = ?", (chave,)).fetchone()
        cartoes.append({"chave": chave, "nome": mod.NOME, "campos": mod.CAMPOS, "cfg": cfg,
                        "configurada": bool(cfg), "ultima": row["ultima_importacao"] if row else None,
                        "autorizada": bool(cfg.get("refresh_token") or cfg.get("access_token"))})
    recentes = db.execute(
        "SELECT p.*, n.status nota_status FROM pedidos_importados p LEFT JOIN notas n ON n.id = p.nota_id "
        "ORDER BY p.id DESC LIMIT 20").fetchall()
    return render_template("integracoes.html", cartoes=cartoes, recentes=recentes,
                           redirect_ml=_redirect_ml(), shopify_versao=PLATAFORMAS["shopify"].VERSAO_PADRAO)


@bp.post("/integracoes/<plataforma>")
@login_required
def integracao_salvar(plataforma):
    mod = _plataforma(plataforma)
    db = get_db()
    cfg = importador.carregar_config(db, plataforma)
    for nome, _rotulo, secreto in mod.CAMPOS:
        valor = request.form.get(nome, "").strip()
        if secreto and not valor:
            continue                       # campo secreto em branco = manter o atual
        cfg[nome] = valor
    if plataforma == "shopify":
        cfg["versao"] = request.form.get("versao", "").strip()
    importador.salvar_config(db, plataforma, cfg)
    flash(f"Credenciais da {mod.NOME} salvas.", "ok")
    return redirect(url_for("main.integracoes") + f"#{plataforma}")


@bp.post("/integracoes/<plataforma>/testar")
@login_required
def integracao_testar(plataforma):
    mod = _plataforma(plataforma)
    db = get_db()
    cfg = importador.carregar_config(db, plataforma)
    try:
        msg = mod.testar(cfg)
        importador.salvar_config(db, plataforma, cfg)
        flash(msg, "ok")
    except ErroIntegracao as exc:
        flash(str(exc), "erro")
    return redirect(url_for("main.integracoes") + f"#{plataforma}")


@bp.post("/integracoes/<plataforma>/importar")
@login_required
def integracao_importar(plataforma):
    mod = _plataforma(plataforma)
    db = get_db()
    dias = int(request.form["dias"]) if request.form.get("dias", "").isdigit() else 30
    dias = min(max(dias, 1), 120)
    try:
        r = importador.importar(db, plataforma, servico.carregar_empresa(db), _salvar_nota, dias)
    except ErroIntegracao as exc:
        flash(str(exc), "erro")
        return redirect(url_for("main.integracoes") + f"#{plataforma}")
    flash(f"{mod.NOME}: {r['novos']} pedido(s) importado(s) como rascunho, "
          f"{r['duplicados']} já importado(s) antes, {len(r['ignorados'])} não importado(s).", "ok")
    for msg in r["ignorados"][:10]:
        flash(msg + " (corrija na loja ou cadastre o documento e importe de novo)", "erro")
    for msg in r["avisos"][:10]:
        flash(msg, "erro")
    return redirect(url_for("main.integracoes") + f"#{plataforma}")


@bp.post("/integracoes/mercadolivre/autorizar")
@login_required
def integracao_ml_autorizar():
    cfg = importador.carregar_config(get_db(), "mercadolivre")
    if not cfg.get("client_id") or not cfg.get("client_secret"):
        flash("Salve o App ID e o Secret antes de autorizar.", "erro")
        return redirect(url_for("main.integracoes") + "#mercadolivre")
    import secrets as _s
    session["ml_state"] = _s.token_urlsafe(24)
    return redirect(ml.url_autorizacao(cfg, _redirect_ml(), session["ml_state"]))


@bp.get("/integracoes/mercadolivre/retorno")
@login_required
def integracao_ml_retorno():
    db = get_db()
    esperado = session.pop("ml_state", None)
    if not esperado or request.args.get("state") != esperado or not request.args.get("code"):
        flash("Autorização do Mercado Livre cancelada ou inválida.", "erro")
        return redirect(url_for("main.integracoes") + "#mercadolivre")
    cfg = importador.carregar_config(db, "mercadolivre")
    try:
        ml.trocar_codigo(cfg, request.args["code"], _redirect_ml())
        importador.salvar_config(db, "mercadolivre", cfg)
        flash("Mercado Livre autorizado.", "ok")
    except ErroIntegracao as exc:
        flash(str(exc), "erro")
    return redirect(url_for("main.integracoes") + "#mercadolivre")

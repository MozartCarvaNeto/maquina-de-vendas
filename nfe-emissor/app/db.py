"""Banco de dados SQLite (simples e suficiente para uma loja)."""
import sqlite3

from flask import current_app, g

from .nfe.util import sem_acento

SCHEMA = """
CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    senha_hash TEXT NOT NULL,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS empresa (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cnpj TEXT, razao_social TEXT, nome_fantasia TEXT,
    ie TEXT, im TEXT, cnae TEXT, crt TEXT DEFAULT '1',
    logradouro TEXT, numero TEXT, complemento TEXT, bairro TEXT,
    cod_municipio TEXT, municipio TEXT, uf TEXT, cep TEXT, fone TEXT, email TEXT,
    ambiente TEXT NOT NULL DEFAULT '2',           -- 1 produção, 2 homologação
    serie TEXT NOT NULL DEFAULT '1',
    autorizador TEXT,                              -- SP, MG, SVRS, ... (vazio = automático pela UF)
    nat_op_padrao TEXT DEFAULT 'VENDA DE MERCADORIA',
    cert_arquivo TEXT, cert_senha_enc TEXT, cert_titular TEXT,
    cert_cnpj TEXT, cert_validade TEXT,
    resp_tec_cnpj TEXT, resp_tec_contato TEXT, resp_tec_email TEXT, resp_tec_fone TEXT
);
INSERT OR IGNORE INTO empresa (id) VALUES (1);

CREATE TABLE IF NOT EXISTS numeracao (
    ambiente TEXT NOT NULL,
    serie TEXT NOT NULL,
    ultimo_numero INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (ambiente, serie)
);

CREATE TABLE IF NOT EXISTS produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT NOT NULL UNIQUE,
    descricao TEXT NOT NULL,
    ncm TEXT NOT NULL,
    cest TEXT,
    ean TEXT,
    unidade TEXT NOT NULL DEFAULT 'UN',
    preco TEXT NOT NULL DEFAULT '0.00',
    origem TEXT NOT NULL DEFAULT '0',
    cfop TEXT NOT NULL DEFAULT '5102',
    cst_icms TEXT NOT NULL DEFAULT '102',          -- CSOSN (Simples) ou CST (regime normal)
    aliq_icms TEXT NOT NULL DEFAULT '0',
    cst_pis TEXT NOT NULL DEFAULT '49',
    aliq_pis TEXT NOT NULL DEFAULT '0',
    cst_cofins TEXT NOT NULL DEFAULT '49',
    aliq_cofins TEXT NOT NULL DEFAULT '0',
    ativo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    documento TEXT NOT NULL,                        -- CPF (11) ou CNPJ (14)
    nome TEXT NOT NULL,
    ind_ie_dest TEXT NOT NULL DEFAULT '9',          -- 1 contribuinte, 2 isento, 9 não contribuinte
    ie TEXT, email TEXT, fone TEXT,
    logradouro TEXT, numero TEXT, complemento TEXT, bairro TEXT,
    cod_municipio TEXT, municipio TEXT, uf TEXT, cep TEXT
);

CREATE TABLE IF NOT EXISTS notas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ambiente TEXT, serie TEXT, numero INTEGER, chave TEXT,
    status TEXT NOT NULL DEFAULT 'rascunho',        -- rascunho, autorizada, rejeitada, denegada, cancelada, pendente
    cliente_id INTEGER REFERENCES clientes(id),
    nat_op TEXT NOT NULL,
    ind_final TEXT NOT NULL DEFAULT '1',
    ind_pres TEXT NOT NULL DEFAULT '2',
    ind_intermed TEXT NOT NULL DEFAULT '0',
    intermed_cnpj TEXT, intermed_id TEXT,
    mod_frete TEXT NOT NULL DEFAULT '9',
    forma_pagto TEXT NOT NULL DEFAULT '99',
    valor_frete TEXT NOT NULL DEFAULT '0.00',
    valor_desconto TEXT NOT NULL DEFAULT '0.00',
    valor_outras TEXT NOT NULL DEFAULT '0.00',
    info_adicional TEXT,
    total_nf TEXT,
    xml_assinado TEXT, xml_proc TEXT,
    protocolo TEXT, c_stat TEXT, x_motivo TEXT, recibo TEXT,
    dh_emissao TEXT, dh_autorizacao TEXT,
    cancel_protocolo TEXT, cancel_xml TEXT, cancel_motivo TEXT, cancel_dh TEXT,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS nota_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nota_id INTEGER NOT NULL REFERENCES notas(id) ON DELETE CASCADE,
    ordem INTEGER NOT NULL,
    produto_id INTEGER,
    codigo TEXT, descricao TEXT, ncm TEXT, cest TEXT, ean TEXT,
    cfop TEXT, unidade TEXT,
    quantidade TEXT, valor_unitario TEXT,
    origem TEXT, cst_icms TEXT, aliq_icms TEXT,
    cst_pis TEXT, aliq_pis TEXT, cst_cofins TEXT, aliq_cofins TEXT
);

CREATE TABLE IF NOT EXISTS sefaz_urls (          -- endereços alterados no painel (Configurações)
    autorizador TEXT NOT NULL,
    ambiente TEXT NOT NULL,
    servico TEXT NOT NULL,
    url TEXT NOT NULL,
    PRIMARY KEY (autorizador, ambiente, servico)
);

CREATE TABLE IF NOT EXISTS integracoes (          -- credenciais das lojas (JSON cifrado)
    plataforma TEXT PRIMARY KEY,
    config_enc TEXT,
    ultima_importacao TEXT,
    atualizado_em TEXT
);

CREATE TABLE IF NOT EXISTS pedidos_importados (   -- evita importar o mesmo pedido duas vezes
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plataforma TEXT NOT NULL,
    externo_id TEXT NOT NULL,
    numero TEXT,
    nota_id INTEGER REFERENCES notas(id) ON DELETE CASCADE,   -- excluir o rascunho libera reimportar
    avisos TEXT,
    importado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (plataforma, externo_id)
);

CREATE TABLE IF NOT EXISTS log_sefaz (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nota_id INTEGER, operacao TEXT, ambiente TEXT,
    c_stat TEXT, x_motivo TEXT, resposta TEXT,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


def migrar(con: sqlite3.Connection):
    """Índices que aceleram a busca de clientes/produtos (seguro rodar sempre)."""
    con.execute("CREATE INDEX IF NOT EXISTS idx_clientes_documento ON clientes (documento)")
    con.commit()


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        from . import tenant
        con = sqlite3.connect(tenant.cfg()["DB_PATH"])
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys = ON")
        con.create_function("sem_acento", 1, sem_acento, deterministic=True)   # busca sem acento
        g.db = con
    return g.db


def close_db(_exc=None):
    con = g.pop("db", None)
    if con is not None:
        con.close()


def init_db(app):
    """Cria as pastas globais. As tabelas de cada conta são criadas no primeiro uso (ver tenant.preparar)."""
    for pasta in (app.config["DATA_DIR"], app.config["DATA_DIR"] / "contas", app.config["SCHEMAS_DIR"]):
        pasta.mkdir(parents=True, exist_ok=True)
    app.teardown_appcontext(close_db)

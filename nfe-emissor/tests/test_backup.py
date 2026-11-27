"""Backup dos XMLs e limite de espaço da conta. Rode com:  python -m unittest discover -s tests"""
import io
import os
import re
import sqlite3
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _ambiente():
    """Mesmas variáveis do test_nfe.py. Só valem se este arquivo rodar sozinho: a configuração é lida uma vez só."""
    os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="nfe-test-"))
    os.environ.setdefault("COOKIE_SECURE", "0")
    os.environ.setdefault("NFE_INTERNAL_SECRET", "segredo-interno-de-teste")
    os.environ.setdefault("NFE_PREFIXO", "/")


_ambiente()


def banco_com_notas():
    from app.db import SCHEMA, migrar
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    migrar(con)
    con.execute("INSERT INTO clientes (documento, nome) VALUES ('52998224725', 'Maria')")
    linhas = [
        ("1", "1", 10, "A" * 44, "autorizada", "<procNFe>10</procNFe>", None, "2026-10-05T10:00:00-03:00"),
        ("1", "1", 11, "B" * 44, "cancelada", "<procNFe>11</procNFe>", "<evento/>", "2026-11-02T10:00:00-03:00"),
        ("2", "1", 3, "C" * 44, "autorizada", "<procNFe>3</procNFe>", None, "2026-11-03T10:00:00-03:00"),
        ("1", "1", 12, "D" * 44, "autorizada", None, None, "2026-11-04T10:00:00-03:00"),
    ]
    for amb, serie, num, chave, st, proc, canc, dh in linhas:
        con.execute("INSERT INTO notas (ambiente, serie, numero, chave, status, nat_op, cliente_id, xml_proc, cancel_xml, "
                    "dh_emissao, dh_autorizacao, protocolo, total_nf) VALUES (?,?,?,?,?,'VENDA',1,?,?,?,?,'135',?)",
                    (amb, serie, num, chave, st, proc, canc, dh, dh, "10.00"))
    con.commit()
    return con


class TestBackup(unittest.TestCase):
    def setUp(self):
        global backup
        from app import backup

    def test_zip_completo_de_producao(self):
        arq, qtd = backup.gerar_zip(banco_com_notas(), None, "1")
        self.assertEqual(qtd, 3)
        z = zipfile.ZipFile(io.BytesIO(arq.read()))
        nomes = z.namelist()
        self.assertIn(f"producao/2026-10/{'A' * 44}-procNFe.xml", nomes)
        self.assertIn(f"producao/2026-11/{'B' * 44}-cancelamento.xml", nomes)
        self.assertNotIn(f"homologacao/2026-11/{'C' * 44}-procNFe.xml", nomes, "teste fica de fora do backup de produção")
        self.assertTrue({"notas.csv", "produtos.csv", "clientes.csv", "LEIA-ME.txt"} <= set(nomes))
        csv_txt = z.read("notas.csv").decode("utf-8-sig")
        self.assertIn("Maria", csv_txt)
        self.assertIn("A" * 44, csv_txt)

    def test_por_mes_e_ambiente_todos(self):
        _, qtd = backup.gerar_zip(banco_com_notas(), "2026-11", "1")
        self.assertEqual(qtd, 2)
        _, qtd = backup.gerar_zip(banco_com_notas(), None, None)
        self.assertEqual(qtd, 4)
        with self.assertRaises(ValueError):
            backup.gerar_zip(banco_com_notas(), "11/2026", "1")

    def test_resumo_acusa_nota_sem_xml(self):
        r = backup.resumo(banco_com_notas())
        self.assertEqual(r["total"], 4)
        self.assertEqual(r["sem_xml"], 1)
        self.assertEqual(r["meses"][0]["mes"], "2026-11")

    def test_reparar_recria_arquivo_sumido(self):
        con = banco_com_notas()
        pasta = Path(tempfile.mkdtemp())
        self.assertEqual(backup.reparar_arquivos(con, {"XML_DIR": pasta}), 4)
        self.assertTrue((pasta / "2026-10" / f"{'A' * 44}-procNFe.xml").exists())
        self.assertEqual(backup.reparar_arquivos(con, {"XML_DIR": pasta}), 0, "segunda vez não refaz nada")


class TestEspaco(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _ambiente()
        from app import create_app
        cls.app = create_app()
        cls.app.config["TESTING"] = True

    def cliente(self, espaco):
        import time
        from app import tenant
        conta, ts = "conta-espaco-0001", str(int(time.time()))
        h = {"HTTP_X_TURBO_ACCOUNT": conta, "HTTP_X_TURBO_USER": "a@b.c", "HTTP_X_TURBO_ROLE": "owner",
             "HTTP_X_TURBO_LIMIT": "", "HTTP_X_TURBO_READONLY": "0", "HTTP_X_TURBO_TS": ts, "HTTP_X_TURBO_STORAGE_MB": espaco,
             "HTTP_X_TURBO_SIG": tenant.assinatura(conta, "a@b.c", "owner", "", "0", ts, espaco)}
        c = self.app.test_client()
        c.environ_base.update(h)
        return c

    def test_espaco_aparece_e_assinatura_protege_o_limite(self):
        c = self.cliente("100")
        self.assertIn("/ 100 MB", c.get("/").get_data(as_text=True))
        # trocar o limite sem refazer a assinatura é recusado
        c2 = self.cliente("100")
        c2.environ_base["HTTP_X_TURBO_STORAGE_MB"] = "999999"
        self.assertEqual(c2.get("/").status_code, 403)

    def test_tela_de_backup_abre_e_espaco_cheio_bloqueia_so_emissao(self):
        c = self.cliente("0")
        self.assertEqual(c.get("/backup").status_code, 200)
        with self.app.test_request_context("/"):
            from flask import g
            from app import tenant
            g.conta, g.limite_mb = "conta-espaco-0001", 0
            self.assertIn("espaço de armazenamento", tenant.erro_de_espaco())
            g.limite_mb = 5000
            self.assertIsNone(tenant.erro_de_espaco())
            g.limite_mb = None
            self.assertIsNone(tenant.erro_de_espaco())


if __name__ == "__main__":
    unittest.main()

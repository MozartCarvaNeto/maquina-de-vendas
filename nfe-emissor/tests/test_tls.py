"""Teste de TLS real (servidor local com CA própria, certificado de cliente e SEM campo AKI,
como nos certificados ICP-Brasil): prova que a cadeia instalada é usada e que o modo estrito
do Python 3.13 não bloqueia."""
import datetime as dt
import http.server
import io
import os
import ssl
import sys
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from cryptography import x509  # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402
from cryptography.x509.oid import NameOID  # noqa: E402

from app.nfe import sefaz, tls  # noqa: E402

NS = "http://www.portalfiscal.inf.br/nfe"
RESP = ('<?xml version="1.0"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">'
        '<soap12:Body><nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4">'
        f'<retConsStatServ xmlns="{NS}" versao="4.00"><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo>'
        '</retConsStatServ></nfeResultMsg></soap12:Body></soap12:Envelope>').encode()


def _nome(cn):
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])


def _cert(sujeito, emissor, chave, chave_emissor, ca=False, san=None):
    agora = dt.datetime.now(dt.timezone.utc)
    b = (x509.CertificateBuilder().subject_name(sujeito).issuer_name(emissor)
         .public_key(chave.public_key()).serial_number(x509.random_serial_number())
         .not_valid_before(agora - dt.timedelta(days=1)).not_valid_after(agora + dt.timedelta(days=30))
         .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True))
    if san:
        b = b.add_extension(x509.SubjectAlternativeName([x509.IPAddress(__import__("ipaddress").ip_address(san))]), False)
    return b.sign(chave_emissor, hashes.SHA256())


class _H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.send_response(200); self.send_header("Content-Type", "application/soap+xml")
        self.send_header("Content-Length", str(len(RESP))); self.end_headers(); self.wfile.write(RESP)

    def log_message(self, *a):
        pass


class TestTlsIcp(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp(prefix="tls-"))
        k_ca = rsa.generate_private_key(65537, 2048)
        cls.ca = _cert(_nome("AC Raiz ICP-Brasil TESTE"), _nome("AC Raiz ICP-Brasil TESTE"), k_ca, k_ca, ca=True)
        k_srv = rsa.generate_private_key(65537, 2048)
        srv = _cert(_nome("sefaz.teste"), cls.ca.subject, k_srv, k_ca, san="127.0.0.1")
        k_cli = rsa.generate_private_key(65537, 2048)
        cli = _cert(_nome("cliente"), cls.ca.subject, k_cli, k_ca)
        pem = lambda c: c.public_bytes(serialization.Encoding.PEM)
        (cls.dir / "srv.pem").write_bytes(pem(srv) + k_srv.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
        (cls.dir / "cli.pem").write_bytes(pem(cli) + k_cli.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
        (cls.dir / "ca.pem").write_bytes(pem(cls.ca))
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cls.dir / "srv.pem")
        ctx.load_verify_locations(cls.dir / "ca.pem")
        ctx.verify_mode = ssl.CERT_REQUIRED
        cls.httpd = http.server.HTTPServer(("127.0.0.1", 0), _H)
        cls.httpd.socket = ctx.wrap_socket(cls.httpd.socket, server_side=True)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        porta = cls.httpd.server_address[1]
        cls.urls = {"SP": {"2": {"NFeStatusServico4": f"https://127.0.0.1:{porta}/ws"}}}

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def _ctx(self, pasta, **kw):
        return sefaz.Contexto(autorizador="SP", ambiente="2", pem=str(self.dir / "cli.pem"),
                              urls_override=self.urls, data_dir=pasta, auto_cadeia=False, **kw)

    def test_sem_cadeia_falha_com_mensagem_clara(self):
        pasta = Path(tempfile.mkdtemp())
        with self.assertRaises(sefaz.SefazErro) as c:
            sefaz.status_servico("35", self._ctx(pasta))
        self.assertIn("ICP-Brasil", str(c.exception))

    def test_cadeia_enviada_em_zip_funciona(self):
        pasta = Path(tempfile.mkdtemp())
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("AC Raiz/raiz.crt", self.ca.public_bytes(serialization.Encoding.DER))
            z.writestr("lixo.txt", b"nada")
        n = tls.salvar_cadeia(pasta, tls.extrair_certificados(buf.getvalue()))
        self.assertEqual(n, 1)
        r = sefaz.status_servico("35", self._ctx(pasta))
        self.assertEqual(r["cstat"], "107")

    def test_arquivo_sem_raiz_icp_e_recusado(self):
        pasta = Path(tempfile.mkdtemp())
        k = rsa.generate_private_key(65537, 2048)
        outro = _cert(_nome("Qualquer CA"), _nome("Qualquer CA"), k, k, ca=True)
        with self.assertRaises(tls.CadeiaErro):
            tls.salvar_cadeia(pasta, [outro])

    def test_download_automatico_quando_falta(self):
        pasta = Path(tempfile.mkdtemp())
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("raiz.crt", self.ca.public_bytes(serialization.Encoding.DER))
        class R:
            content = buf.getvalue()
            def raise_for_status(self): pass
        from unittest import mock
        ctx = self._ctx(pasta); ctx.auto_cadeia = True
        with mock.patch.object(tls.requests, "get", return_value=R()):
            r = sefaz.status_servico("35", ctx)
        self.assertEqual(r["cstat"], "107")
        self.assertTrue(tls.tem_cadeia(pasta))


if __name__ == "__main__":
    unittest.main()

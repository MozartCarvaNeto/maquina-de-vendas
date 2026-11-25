"""Testes do emissor. Rode com:  python -m unittest discover -s tests -v

Não falam com a SEFAZ de verdade: as respostas são simuladas. Eles provam que o XML é
gerado, assinado e interpretado de forma coerente, não que a SEFAZ vai aprovar.
"""
import datetime as dt
import io
import os
import re
import sys
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from unittest import mock

TMP = tempfile.mkdtemp(prefix="nfe-test-")
os.environ["DATA_DIR"] = TMP
os.environ["COOKIE_SECURE"] = "0"
os.environ["NFE_INTERNAL_SECRET"] = "segredo-interno-de-teste"
os.environ["NFE_PREFIXO"] = "/"   # nos testes não há prefixo (cookie vale para tudo)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cryptography import x509  # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402
from cryptography.hazmat.primitives.serialization import pkcs12  # noqa: E402
from cryptography.x509.oid import NameOID  # noqa: E402
from lxml import etree  # noqa: E402

from app.nfe import sefaz  # noqa: E402
from app.nfe.assinatura import assinar, verificar  # noqa: E402
from app.nfe.certificado import carregar_pfx  # noqa: E402
from app.nfe.chave import dv_chave, gerar_cnf  # noqa: E402
from app.nfe.danfe import gerar_danfe  # noqa: E402
from app.nfe.sefaz_urls import SERVICOS, listar_urls, obter_url  # noqa: E402
from app.nfe.util import validar_cnpj, validar_cpf, validar_documento  # noqa: E402
from app.nfe.xml_builder import (NS, DadosInvalidos, construir_nfe, serializar)  # noqa: E402

CNPJ_EMPRESA = "11222333000181"
SENHA_PFX = "senha-pfx"


def gerar_pfx(cnpj=CNPJ_EMPRESA, dias=365) -> bytes:
    chave = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    nome = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"EMPRESA TESTE LTDA:{cnpj}")])
    agora = dt.datetime.now(dt.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(nome).issuer_name(nome)
            .public_key(chave.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(agora - dt.timedelta(days=1))
            .not_valid_after(agora + dt.timedelta(days=dias)).sign(chave, hashes.SHA256()))
    return pkcs12.serialize_key_and_certificates(
        b"teste", chave, cert, None, serialization.BestAvailableEncryption(SENHA_PFX.encode()))


EMPRESA = {
    "cnpj": CNPJ_EMPRESA, "razao_social": "EMPRESA TESTE LTDA", "nome_fantasia": "Loja Teste",
    "ie": "111222333444", "im": "", "cnae": "", "crt": "1", "logradouro": "Rua das Flores",
    "numero": "100", "complemento": "", "bairro": "Centro", "cod_municipio": "3525904",
    "municipio": "Jundiai", "uf": "SP", "cep": "13201000", "fone": "11999998888",
    "ambiente": "2", "serie": "1", "resp_tec_cnpj": "", "resp_tec_contato": "",
    "resp_tec_email": "", "resp_tec_fone": "",
}
CLIENTE = {
    "documento": "52998224725", "nome": "Maria da Silva", "ind_ie_dest": "9", "ie": "",
    "email": "maria@exemplo.com", "fone": "11988887777", "logradouro": "Av. Brasil",
    "numero": "500", "complemento": "Apto 3", "bairro": "Jardim", "cod_municipio": "3550308",
    "municipio": "Sao Paulo", "uf": "SP", "cep": "01310100",
}


def item(codigo="SKU1", qtd="2", vun="49,90", cfop="5102", cst="102", **extra):
    base = {"codigo": codigo, "descricao": f"Produto {codigo}", "ncm": "61091000", "cest": "",
            "ean": "", "cfop": cfop, "unidade": "UN", "quantidade": qtd, "valor_unitario": vun,
            "origem": "0", "cst_icms": cst, "aliq_icms": "0", "cst_pis": "49", "aliq_pis": "0",
            "cst_cofins": "49", "aliq_cofins": "0"}
    base.update(extra)
    return base


NOTA = {"nat_op": "VENDA DE MERCADORIA", "ind_final": "1", "ind_pres": "2", "ind_intermed": "0",
        "mod_frete": "9", "forma_pagto": "17", "valor_frete": "10,00", "valor_desconto": "5,00",
        "valor_outras": "0", "info_adicional": "Pedido 1234", "serie": "1"}

DH = dt.datetime(2026, 11, 22, 12, 0, 0, tzinfo=dt.timezone(dt.timedelta(hours=-3)))


def montar(empresa=None, cliente=None, itens=None, nota=None, numero=7, tp_amb="2"):
    return construir_nfe(empresa or EMPRESA, cliente or CLIENTE, itens or [item("A"), item("B", "1", "10")],
                         nota or NOTA, numero=numero, dh_emissao=DH, cnf="48271905", tp_amb=tp_amb)


def png_teste(cor=(200, 30, 30), tamanho=(500, 200), alfa=False) -> bytes:
    from PIL import Image
    modo_img = "RGBA" if alfa else "RGB"
    img = Image.new(modo_img, tamanho, cor + ((0,) if alfa else ()))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


class TestDocumentos(unittest.TestCase):
    def test_cpf_cnpj(self):
        self.assertTrue(validar_cpf("529.982.247-25"))
        self.assertFalse(validar_cpf("111.111.111-11"))
        self.assertTrue(validar_cnpj("11.222.333/0001-81"))
        self.assertFalse(validar_cnpj("11.222.333/0001-82"))
        self.assertTrue(validar_documento(CLIENTE["documento"]))

    def test_cnpj_alfanumerico_dv(self):
        # monta um CNPJ alfanumérico com DVs calculados pela mesma regra e valida
        base = "12ABC34501DE"
        pesos1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        pesos2 = [6] + pesos1

        def dv(txt, pesos):
            r = sum((ord(c) - 48) * p for c, p in zip(txt, pesos)) % 11
            return 0 if r < 2 else 11 - r
        d1 = dv(base, pesos1)
        d2 = dv(base + str(d1), pesos2)
        self.assertTrue(validar_cnpj(f"{base}{d1}{d2}"))

    def test_dv_chave_exemplo_do_manual(self):
        self.assertEqual(dv_chave("3508059999909091027055001000000001518005127"), 3)

    def test_cnf(self):
        for n in (1, 12345678, 99):
            cnf = gerar_cnf(n)
            self.assertEqual(len(cnf), 8)
            self.assertNotEqual(cnf, str(n).zfill(8))


class TestXmlEAssinatura(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cert = carregar_pfx(gerar_pfx(), SENHA_PFX)

    def test_certificado_le_cnpj(self):
        self.assertEqual(self.cert.cnpj, CNPJ_EMPRESA)
        self.assertFalse(self.cert.vencido)

    def test_senha_errada(self):
        from app.nfe.certificado import CertificadoErro
        with self.assertRaises(CertificadoErro):
            carregar_pfx(gerar_pfx(), "errada")

    def test_estrutura_e_totais(self):
        nfe, chave, calc = montar()
        self.assertEqual(len(chave), 44)
        self.assertEqual(chave[:2], "35")            # UF SP
        self.assertEqual(chave[2:6], "2611")          # AAMM
        self.assertEqual(chave[6:20], CNPJ_EMPRESA)
        self.assertEqual(chave[20:22], "55")
        self.assertEqual(chave[25:34], "000000007")   # nº da nota
        self.assertEqual(chave[-1], str(dv_chave(chave[:-1])))
        # ordem dos elementos de infNFe conforme o XSD
        inf = nfe.find(f"{{{NS}}}infNFe")
        ordem = [etree.QName(c).localname for c in inf]
        self.assertEqual(ordem, ["ide", "emit", "dest", "det", "det", "total", "transp", "pag", "infAdic"])
        # 2 x 49,90 + 1 x 10,00 = 109,80 ; frete 10 ; desconto 5 -> 114,80
        t = calc["totais"]
        self.assertEqual(t["vProd"], Decimal("109.80"))
        self.assertEqual(t["vNF"], Decimal("114.80"))
        soma_itens = sum(Decimal(d.find(f"{{{NS}}}prod/{{{NS}}}vProd").text) for d in inf.findall(f"{{{NS}}}det"))
        self.assertEqual(soma_itens, t["vProd"])
        soma_frete = sum(Decimal(d.findtext(f"{{{NS}}}prod/{{{NS}}}vFrete") or "0") for d in inf.findall(f"{{{NS}}}det"))
        self.assertEqual(soma_frete, Decimal("10.00"))
        soma_desc = sum(Decimal(d.findtext(f"{{{NS}}}prod/{{{NS}}}vDesc") or "0") for d in inf.findall(f"{{{NS}}}det"))
        self.assertEqual(soma_desc, Decimal("5.00"))
        self.assertEqual(inf.findtext(f"{{{NS}}}total/{{{NS}}}ICMSTot/{{{NS}}}vNF"), "114.80")
        self.assertEqual(inf.findtext(f"{{{NS}}}pag/{{{NS}}}detPag/{{{NS}}}vPag"), "114.80")

    def test_homologacao_troca_nome_destinatario(self):
        nfe, _, _ = montar(tp_amb="2")
        self.assertIn("HOMOLOGACAO", nfe.findtext(f".//{{{NS}}}dest/{{{NS}}}xNome"))
        nfe, _, _ = montar(tp_amb="1")
        self.assertEqual(nfe.findtext(f".//{{{NS}}}dest/{{{NS}}}xNome"), "Maria da Silva")

    def test_cfop_interestadual(self):
        cli = {**CLIENTE, "uf": "MG"}
        nfe, _, _ = montar(cliente=cli)
        self.assertEqual(nfe.findtext(f".//{{{NS}}}det/{{{NS}}}prod/{{{NS}}}CFOP"), "6102")
        self.assertEqual(nfe.findtext(f".//{{{NS}}}ide/{{{NS}}}idDest"), "2")

    def test_regime_normal_icms00(self):
        emp = {**EMPRESA, "crt": "3"}
        it = item(cst="00", aliq_icms="18", cst_pis="01", aliq_pis="0,65", cst_cofins="01", aliq_cofins="3")
        nfe, _, calc = montar(empresa=emp, itens=[it], nota={**NOTA, "valor_frete": "0", "valor_desconto": "0"})
        self.assertEqual(calc["totais"]["vBC"], Decimal("99.80"))
        self.assertEqual(calc["totais"]["vICMS"], Decimal("17.96"))
        self.assertIsNotNone(nfe.find(f".//{{{NS}}}ICMS00"))
        self.assertIsNotNone(nfe.find(f".//{{{NS}}}PISAliq"))

    def test_dados_invalidos(self):
        with self.assertRaises(DadosInvalidos) as ctx:
            montar(itens=[item(ncm="123")])
        self.assertTrue(any("NCM" in e for e in ctx.exception.erros))
        with self.assertRaises(DadosInvalidos):
            montar(cliente={**CLIENTE, "documento": "123"})

    def test_assinatura_valida_e_adulteracao(self):
        nfe, chave, _ = montar()
        inf = nfe.find(f"{{{NS}}}infNFe")
        assinar(nfe, inf, self.cert)
        self.assertEqual([etree.QName(c).localname for c in nfe], ["infNFe", "Signature"])
        self.assertTrue(verificar(nfe))
        # sobrevive à serialização -> parse (é isso que a SEFAZ faz)
        recarregado = etree.fromstring(serializar(nfe).encode())
        self.assertTrue(verificar(recarregado))
        # dentro de um enviNFe também continua válida
        env = etree.fromstring(f'<enviNFe xmlns="{NS}" versao="4.00"><idLote>1</idLote><indSinc>1</indSinc>{serializar(nfe)}</enviNFe>'.encode())
        self.assertTrue(verificar(env))
        # adulterar qualquer valor invalida
        adulterado = serializar(nfe).replace("Pedido 1234", "Pedido 9999")
        self.assertFalse(verificar(etree.fromstring(adulterado.encode())))
        # sem espaços/quebras entre as tags
        self.assertNotRegex(serializar(nfe), r">\s+<")
        self.assertNotIn("<?xml", serializar(nfe))

    def test_c14n_sem_xmlns_vazio_e_igual_ao_documento_inteiro(self):
        """Regressão da rejeição 297: o lxml 6.x injeta xmlns="" ao canonicalizar um sub-elemento.

        A referência é independente: C14N do documento inteiro (sem a Signature), onde o bug não
        existe. O verificar() sozinho não pega isso, pois usa a mesma função da assinatura.
        """
        import base64
        import hashlib
        nfe, _, _ = montar(cliente={**CLIENTE, "nome": "M DAS GRAÇAS & CIA <teste>"})
        inf = nfe.find(f"{{{NS}}}infNFe")
        assinar(nfe, inf, self.cert)
        doc = etree.fromstring(serializar(nfe).encode())
        ds = "{http://www.w3.org/2000/09/xmldsig#}"
        digest_assinado = doc.find(f"{ds}Signature/{ds}SignedInfo/{ds}Reference/{ds}DigestValue").text
        doc.remove(doc.find(f"{ds}Signature"))
        inteiro = etree.tostring(etree.ElementTree(doc), method="c14n")
        ini = inteiro.index(b"<infNFe") + len(b"<infNFe")
        fim = inteiro.rindex(b"</infNFe>") + len(b"</infNFe>")
        esperado = b'<infNFe xmlns="' + NS.encode() + b'"' + inteiro[ini:fim]
        self.assertNotIn(b'xmlns=""', esperado)
        self.assertEqual(base64.b64encode(hashlib.sha1(esperado).digest()).decode(), digest_assinado)

    def test_danfe_pdf(self):
        nfe, _, _ = montar()
        pdf = gerar_danfe(serializar(nfe))
        self.assertTrue(pdf.startswith(b"%PDF"))
        # muitos itens -> várias páginas, sem erro
        muitos = [item(f"P{i}", "1", "9,99") for i in range(70)]
        nfe, _, _ = montar(itens=muitos, nota={**NOTA, "info_adicional": "x " * 400})
        pdf = gerar_danfe(serializar(nfe), cancelada=True)
        self.assertGreater(pdf.count(b"/Type /Page\n") + pdf.count(b"/Type /Page "), 1)

    def test_danfe_com_logotipo(self):
        from app import logo
        nfe, _, _ = montar()
        xml = serializar(nfe)
        sem = gerar_danfe(xml)
        self.assertNotIn(b"/Subtype /Image", sem)                      # padrão: nada muda sem logotipo
        png = logo.normalizar(png_teste(alfa=True))                    # transparente vira fundo branco
        com = gerar_danfe(xml, logo=png)
        self.assertTrue(com.startswith(b"%PDF"))
        self.assertIn(b"/Subtype /Image", com)
        # logotipo com defeito nunca derruba o DANFE
        self.assertTrue(gerar_danfe(xml, logo=b"isto nao e uma imagem").startswith(b"%PDF"))
        # nome longo + muitos itens com logotipo: várias linhas, sem erro
        longa = {**EMPRESA, "razao_social": "COMERCIO DE CONFECCOES E ACESSORIOS DA MODA LTDA ME",
                 "logradouro": "Avenida Presidente Juscelino Kubitschek de Oliveira"}
        nfe, _, _ = montar(empresa=longa, itens=[item(f"P{i}", "1", "9,99") for i in range(40)])
        self.assertTrue(gerar_danfe(serializar(nfe), logo=png).startswith(b"%PDF"))

    def test_logotipo_validacao(self):
        from app import logo
        for ruim in (b"", b"texto qualquer", b"<svg xmlns='http://www.w3.org/2000/svg'/>",
                     b"GIF89a" + b"\x00" * 40, png_teste(tamanho=(10, 10)), b"\x89PNG" + b"0" * 100):
            with self.assertRaises(logo.LogoInvalido):
                logo.normalizar(ruim)
        with self.assertRaises(logo.LogoInvalido):
            logo.normalizar(b"0" * (logo.TAMANHO_MAX + 1))
        grande = logo.normalizar(png_teste(tamanho=(3000, 1500)))     # é reduzido
        from PIL import Image
        self.assertLessEqual(max(Image.open(io.BytesIO(grande)).size), logo.LADO_SAIDA)


def _ret_autorizacao(chave, cstat_prot="100", cstat_lote="104"):
    return etree.fromstring(
        f'<retEnviNFe xmlns="{NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>X</verAplic>'
        f'<cStat>{cstat_lote}</cStat><xMotivo>Lote processado</xMotivo><cUF>35</cUF>'
        f'<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>X</verAplic><chNFe>{chave}</chNFe>'
        f'<dhRecbto>2026-11-22T12:00:05-03:00</dhRecbto><nProt>135260000000001</nProt>'
        f'<digVal>abc=</digVal><cStat>{cstat_prot}</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo>'
        f'</infProt></protNFe></retEnviNFe>'.encode())


class TestSefazSimulada(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cert = carregar_pfx(gerar_pfx(), SENHA_PFX)
        cls.ctx = sefaz.Contexto(autorizador="SP", ambiente="2", pem="/dev/null")

    def _nfe(self):
        nfe, chave, _ = montar()
        assinar(nfe, nfe.find(f"{{{NS}}}infNFe"), self.cert)
        return nfe, chave

    def test_autorizada(self):
        nfe, chave = self._nfe()
        with mock.patch.object(sefaz, "chamar", return_value=_ret_autorizacao(chave)) as m:
            r = sefaz.autorizar(nfe, chave, "1", self.ctx)
        self.assertEqual(r["status"], "autorizada")
        self.assertEqual(r["protocolo"], "135260000000001")
        proc = etree.fromstring(r["xml_proc"].encode())
        self.assertEqual([etree.QName(c).localname for c in proc], ["NFe", "protNFe"])
        self.assertTrue(verificar(proc))  # assinatura segue válida dentro do nfeProc
        enviado = m.call_args[0][1]
        self.assertIn("<indSinc>1</indSinc>", enviado)

    def test_rejeitada_no_protocolo(self):
        nfe, chave = self._nfe()
        with mock.patch.object(sefaz, "chamar", return_value=_ret_autorizacao(chave, "539")):
            r = sefaz.autorizar(nfe, chave, "1", self.ctx)
        self.assertEqual(r["status"], "rejeitada")
        self.assertNotIn("xml_proc", r)

    def test_denegada(self):
        nfe, chave = self._nfe()
        with mock.patch.object(sefaz, "chamar", return_value=_ret_autorizacao(chave, "110")):
            self.assertEqual(sefaz.autorizar(nfe, chave, "1", self.ctx)["status"], "denegada")

    def test_rejeicao_do_lote(self):
        nfe, chave = self._nfe()
        ret = etree.fromstring(f'<retEnviNFe xmlns="{NS}" versao="4.00"><cStat>225</cStat>'
                               f'<xMotivo>Falha no Schema XML</xMotivo></retEnviNFe>'.encode())
        with mock.patch.object(sefaz, "chamar", return_value=ret):
            r = sefaz.autorizar(nfe, chave, "1", self.ctx)
        self.assertEqual((r["status"], r["cstat"]), ("rejeitada", "225"))

    def test_assincrono_com_recibo(self):
        nfe, chave = self._nfe()
        recibo = etree.fromstring(f'<retEnviNFe xmlns="{NS}"><cStat>103</cStat><xMotivo>Lote recebido</xMotivo>'
                                  f'<infRec><nRec>351000000000001</nRec></infRec></retEnviNFe>'.encode())
        andamento = etree.fromstring(f'<retConsReciNFe xmlns="{NS}"><cStat>105</cStat><xMotivo>em processamento</xMotivo></retConsReciNFe>'.encode())
        pronto = _ret_autorizacao(chave)
        with mock.patch.object(sefaz, "chamar", side_effect=[recibo, andamento, pronto]), \
                mock.patch.object(sefaz.time, "sleep"):
            r = sefaz.autorizar(nfe, chave, "1", self.ctx)
        self.assertEqual((r["status"], r["recibo"]), ("autorizada", "351000000000001"))

    def test_protocolo_de_outra_chave_e_recusado(self):
        nfe, chave = self._nfe()
        with mock.patch.object(sefaz, "chamar", return_value=_ret_autorizacao("1" * 44)):
            with self.assertRaises(sefaz.SefazErro):
                sefaz.autorizar(nfe, chave, "1", self.ctx)

    def test_cancelamento(self):
        nfe, chave = self._nfe()
        ret = etree.fromstring(
            f'<retEnvEvento xmlns="{NS}" versao="1.00"><idLote>1</idLote><tpAmb>2</tpAmb><cStat>128</cStat>'
            f'<xMotivo>Lote de Evento Processado</xMotivo><retEvento versao="1.00"><infEvento>'
            f'<cStat>135</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo><nProt>135260000000002</nProt>'
            f'</infEvento></retEvento></retEnvEvento>'.encode())
        with mock.patch.object(sefaz, "chamar", return_value=ret) as m:
            r = sefaz.cancelar(cert=self.cert, cuf="35", cnpj=CNPJ_EMPRESA, chave=chave,
                               protocolo="135260000000001", justificativa="Erro no pedido do cliente",
                               dh_evento=DH, ctx=self.ctx)
        self.assertTrue(r["cancelada"])
        enviado = etree.fromstring(m.call_args[0][1].encode())
        self.assertTrue(verificar(enviado))
        self.assertIn(f"ID110111{chave}01", m.call_args[0][1])
        with self.assertRaises(ValueError):
            sefaz.cancelar(cert=self.cert, cuf="35", cnpj=CNPJ_EMPRESA, chave=chave, protocolo="1",
                           justificativa="curta", dh_evento=DH, ctx=self.ctx)

    def test_envelope_soap(self):
        captura = {}

        class Resp:
            status_code = 200
            content = (f'<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>'
                       f'<nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4">'
                       f'<retConsStatServ xmlns="{NS}"><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo>'
                       f'</retConsStatServ></nfeResultMsg></soap12:Body></soap12:Envelope>').encode()

        def falso_post(url, data, headers, cert, timeout, verify):
            captura.update(url=url, data=data.decode(), headers=headers, cert=cert, verify=verify)
            return Resp()
        with mock.patch.object(sefaz.requests, "post", side_effect=falso_post):
            r = sefaz.status_servico("35", self.ctx)
        self.assertEqual(r["cstat"], "107")
        self.assertEqual(captura["url"], "https://homologacao.nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx")
        self.assertIn("soap12:Envelope", captura["data"])
        self.assertIn("NFeStatusServico4", captura["headers"]["Content-Type"])
        self.assertIs(captura["verify"], True)


class TestUrlsSefaz(unittest.TestCase):
    def test_padrao_e_alteracoes(self):
        self.assertTrue(all(listar_urls("SP", "2").values()))
        # autorizador sem endereço cadastrado: vazio e erro claro
        self.assertEqual(set(listar_urls("MT", "2").values()), {""})
        with self.assertRaises(KeyError) as ctx:
            obter_url("MT", "2", "NFeAutorizacao4")
        self.assertIn("Configurações", str(ctx.exception))
        # alterações feitas no painel (dict) entram por cima do padrão
        extra = {"MT": {"2": {"NFeAutorizacao4": "https://hom.sefaz.mt.gov.br/x"}},
                 "SP": {"2": {"NFeStatusServico4": "https://novo.fazenda.sp.gov.br/s"}}}
        self.assertEqual(obter_url("MT", "2", "NFeAutorizacao4", extra), "https://hom.sefaz.mt.gov.br/x")
        self.assertEqual(obter_url("SP", "2", "NFeStatusServico4", extra), "https://novo.fazenda.sp.gov.br/s")
        self.assertEqual(obter_url("SP", "2", "NFeAutorizacao4", extra),
                         "https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx")


class _RespStatus:
    status_code = 200
    content = (f'<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>'
               f'<nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4">'
               f'<retConsStatServ xmlns="{NS}"><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo>'
               f'</retConsStatServ></nfeResultMsg></soap12:Body></soap12:Envelope>').encode()


class TestAplicacaoWeb(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from app import create_app
        cls.app = create_app()
        cls.app.config["TESTING"] = True

    CONTA = "conta-aaaaaaaa-1111"

    def cabecalhos(self, conta=None, limite="", leitura="0", ts=None, sig=None):
        """Cabeçalhos que o Turbo Prospect envia (assinados com NFE_INTERNAL_SECRET)."""
        from app import tenant
        conta = conta or self.CONTA
        ts = str(ts if ts is not None else int(__import__("time").time()))
        sig = sig or tenant.assinatura(conta, "dono@exemplo.com", "owner", limite, leitura, ts)
        return {"HTTP_X_TURBO_ACCOUNT": conta, "HTTP_X_TURBO_USER": "dono@exemplo.com", "HTTP_X_TURBO_ROLE": "owner",
                "HTTP_X_TURBO_LIMIT": limite, "HTTP_X_TURBO_READONLY": leitura, "HTTP_X_TURBO_TS": ts,
                "HTTP_X_TURBO_SIG": sig}

    def cliente(self, **kw):
        c = self.app.test_client()
        c.environ_base.update(self.cabecalhos(**kw))
        return c

    def setUp(self):
        self.c = self.cliente()

    def token(self, caminho):
        html = self.c.get(caminho).get_data(as_text=True)
        m = re.search(r'name="csrf_token" value="([^"]+)"', html)
        self.assertIsNotNone(m, f"sem csrf em {caminho}")
        return m.group(1)

    def post(self, caminho, dados, token_de=None, **kw):
        dados = {**dados, "csrf_token": self.token(token_de or caminho)}
        return self.c.post(caminho, data=dados, follow_redirects=True, **kw)

    def test_fluxo_completo(self):
        # sem os cabeçalhos assinados do Turbo Prospect, o emissor recusa tudo
        self.assertEqual(self.app.test_client().get("/notas").status_code, 403)
        # csrf obrigatório
        self.assertEqual(self.c.post("/configuracoes", data={"cnpj": "x"}).status_code, 400)
        r = self.c.get("/")
        self.assertIn("Painel", r.get_data(as_text=True))

        # empresa
        r = self.post("/configuracoes", {
            "cnpj": CNPJ_EMPRESA, "razao_social": "EMPRESA TESTE LTDA", "ie": "111222333444", "crt": "1",
            "cep": "13201000", "logradouro": "Rua das Flores", "numero": "100", "bairro": "Centro",
            "municipio": "Jundiai", "cod_municipio": "3525904", "uf": "SP", "ambiente": "2",
            "serie": "1", "ultimo_numero": "40"}, token_de="/configuracoes")
        self.assertIn("Configurações salvas", r.get_data(as_text=True))

        # certificado (CNPJ de outra raiz é recusado)
        r = self.post("/configuracoes/certificado", {"senha_certificado": SENHA_PFX, "certificado": (
            __import__("io").BytesIO(gerar_pfx(cnpj="52998224000100")), "outro.pfx")},
            token_de="/configuracoes", content_type="multipart/form-data")
        self.assertIn("mesma raiz", r.get_data(as_text=True))
        r = self.post("/configuracoes/certificado", {"senha_certificado": SENHA_PFX, "certificado": (
            __import__("io").BytesIO(gerar_pfx()), "cert.pfx")},
            token_de="/configuracoes", content_type="multipart/form-data")
        self.assertIn("Certificado salvo", r.get_data(as_text=True))

        # produto e cliente
        r = self.post("/produtos/novo", {
            "codigo": "CAM-001", "descricao": "Camiseta Algodao", "preco": "49,90", "ncm": "61091000",
            "unidade": "UN", "origem": "0", "cfop": "5102", "cst_icms": "102", "aliq_icms": "0",
            "cst_pis": "49", "cst_cofins": "49", "aliq_pis": "0", "aliq_cofins": "0"})
        self.assertIn("Produto salvo", r.get_data(as_text=True))
        r = self.post("/produtos/novo", {"codigo": "CAM-001", "descricao": "x", "ncm": "123", "cfop": "5102",
                                         "cst_icms": "102"})
        self.assertIn("NCM deve ter 8", r.get_data(as_text=True))
        r = self.post("/clientes/novo", {
            "documento": "529.982.247-25", "nome": "Maria da Silva", "ind_ie_dest": "9",
            "cep": "01310100", "logradouro": "Av. Brasil", "numero": "500", "bairro": "Jardim",
            "municipio": "Sao Paulo", "cod_municipio": "3550308", "uf": "SP"})
        self.assertIn("Cliente salvo", r.get_data(as_text=True))

        # nota
        r = self.post("/notas/nova", {"cliente_id": "1", "produto_id": ["1"], "quantidade": ["2"],
                                      "valor_unitario": ["49,90"], "forma_pagto": "17", "mod_frete": "9",
                                      "valor_frete": "10,00", "valor_desconto": "0", "valor_outras": "0"})
        html = r.get_data(as_text=True)
        self.assertIn("Nota salva como rascunho", html)
        self.assertIn("109,80", html)

        # emissão com SEFAZ simulada
        def falso_autorizar(nfe_el, chave, id_lote, ctx):
            return {"status": "autorizada", "cstat": "100", "xmotivo": "Autorizado o uso da NF-e",
                    "protocolo": "135260000000099", "dh_autorizacao": "2026-11-22T12:00:05-03:00",
                    "recibo": None, "resposta": "<ok/>",
                    "xml_proc": sefaz.montar_nfe_proc(
                        nfe_el, _ret_autorizacao(chave).find(f"{{{NS}}}protNFe"))}
        with mock.patch("app.servico.sefaz.autorizar", side_effect=falso_autorizar):
            r = self.post("/notas/1/emitir", {}, token_de="/notas/1")
        html = r.get_data(as_text=True)
        self.assertIn("NF-e autorizada", html)

        with self.app.test_request_context("/"):
            from flask import g as _g
            _g.conta = self.CONTA
            from app.db import get_db
            row = get_db().execute("SELECT * FROM notas WHERE id = 1").fetchone()
            self.assertEqual(row["status"], "autorizada")
            self.assertEqual(row["numero"], 41)          # continuou a partir do "último número"
            self.assertEqual(row["ambiente"], "2")

        # não permite emitir de novo
        with mock.patch("app.servico.sefaz.autorizar", side_effect=AssertionError("não deveria enviar")):
            r = self.post("/notas/1/emitir", {}, token_de="/notas/1")
        self.assertIn("não pode ser emitida novamente", r.get_data(as_text=True))

        # downloads
        x = self.c.get("/notas/1/xml")
        self.assertEqual(x.status_code, 200)
        self.assertIn(b"nfeProc", x.data)
        d = self.c.get("/notas/1/danfe.pdf")
        self.assertEqual(d.status_code, 200)
        self.assertTrue(d.data.startswith(b"%PDF"))

        # cancelamento (simulado)
        def falso_cancelar(**kw):
            return {"cstat": "135", "xmotivo": "Evento registrado", "protocolo": "135260000000100",
                    "cancelada": True, "xml_evento": "<procEventoNFe/>", "resposta": "<ok/>"}
        with mock.patch("app.servico.sefaz.cancelar", side_effect=falso_cancelar):
            r = self.post("/notas/1/cancelar", {"justificativa": "Pedido cancelado pelo cliente"},
                          token_de="/notas/1")
        self.assertIn("NF-e cancelada", r.get_data(as_text=True))

        # exportação mensal
        z = self.c.get("/notas/exportar?mes=2026-11&ambiente=2")
        self.assertEqual(z.status_code, 200)
        self.assertTrue(z.data.startswith(b"PK"))

    def test_cabecalhos_e_healthz(self):
        r = self.c.get("/")
        self.assertEqual(r.headers["X-Frame-Options"], "SAMEORIGIN")
        self.assertIn("default-src 'self'", r.headers["Content-Security-Policy"])
        self.assertEqual(self.app.test_client().get("/healthz").json, {"ok": True})

    def test_assinatura_invalida_ou_vencida(self):
        c = self.app.test_client()
        c.environ_base.update(self.cabecalhos(sig="0" * 64))
        self.assertEqual(c.get("/").status_code, 403)                    # assinatura errada
        c = self.app.test_client()
        c.environ_base.update(self.cabecalhos(ts=int(__import__("time").time()) - 3600))
        self.assertEqual(c.get("/").status_code, 403)                    # assinatura antiga (replay)
        # trocar a conta mantendo a assinatura de outra também falha
        h = self.cabecalhos()
        h["HTTP_X_TURBO_ACCOUNT"] = "conta-bbbbbbbb-2222"
        c = self.app.test_client()
        c.environ_base.update(h)
        self.assertEqual(c.get("/").status_code, 403)

    def test_contas_isoladas(self):
        a, b = self.cliente(conta="conta-iso-aaaaaaaa"), self.cliente(conta="conta-iso-bbbbbbbb")
        tok = re.search(r'name="csrf_token" value="([^"]+)"', a.get("/produtos/novo").get_data(as_text=True)).group(1)
        a.post("/produtos/novo", data={"csrf_token": tok, "codigo": "SO-DA-A", "descricao": "Produto da conta A",
                                       "ncm": "61091000", "cfop": "5102", "cst_icms": "102", "preco": "10"})
        self.assertIn("SO-DA-A", a.get("/produtos").get_data(as_text=True))
        self.assertNotIn("SO-DA-A", b.get("/produtos").get_data(as_text=True))   # B não vê o produto de A
        self.assertTrue((Path(TMP) / "contas" / "conta-iso-aaaaaaaa" / "nfe.db").exists())
        self.assertTrue((Path(TMP) / "contas" / "conta-iso-bbbbbbbb" / "nfe.db").exists())

    def test_logotipo_por_conta(self):
        a, b = self.cliente(conta="conta-logo-aaaaaaaa"), self.cliente(conta="conta-logo-bbbbbbbb")

        def token(c):
            return re.search(r'name="csrf_token" value="([^"]+)"',
                             c.get("/configuracoes").get_data(as_text=True)).group(1)

        def enviar(c, dados, nome="logo.png"):
            return c.post("/configuracoes/logo", follow_redirects=True, content_type="multipart/form-data",
                          data={"csrf_token": token(c), "logo": (io.BytesIO(dados), nome)})

        self.assertEqual(a.get("/configuracoes/logo.png").status_code, 404)    # ainda sem logotipo
        self.assertIn("Nenhum logotipo", a.get("/configuracoes").get_data(as_text=True))
        # arquivo inválido é recusado com mensagem clara
        r = enviar(a, b"<svg/>", "logo.svg")
        self.assertIn("não reconhecido", r.get_data(as_text=True))
        self.assertEqual(a.get("/configuracoes/logo.png").status_code, 404)
        # envio válido
        r = enviar(a, png_teste())
        self.assertIn("Logotipo salvo", r.get_data(as_text=True))
        img = a.get("/configuracoes/logo.png")
        self.assertEqual((img.status_code, img.mimetype), (200, "image/png"))
        self.assertTrue(img.data.startswith(b"\x89PNG"))
        self.assertTrue((Path(TMP) / "contas" / "conta-logo-aaaaaaaa" / "logo.png").exists())
        # isolamento: a conta B não enxerga o logotipo de A
        self.assertEqual(b.get("/configuracoes/logo.png").status_code, 404)
        self.assertFalse((Path(TMP) / "contas" / "conta-logo-bbbbbbbb" / "logo.png").exists())
        # sem CSRF não grava
        self.assertEqual(b.post("/configuracoes/logo", data={"logo": (io.BytesIO(png_teste()), "x.png")},
                                content_type="multipart/form-data").status_code, 400)
        # remover
        r = a.post("/configuracoes/logo/remover", data={"csrf_token": token(a)}, follow_redirects=True)
        self.assertIn("Logotipo removido", r.get_data(as_text=True))
        self.assertEqual(a.get("/configuracoes/logo.png").status_code, 404)

    def test_importacao_web(self):
        from unittest import mock
        c = self.cliente(conta="conta-import-aaaaaaaa")

        def token(url):
            return re.search(r'name="csrf_token" value="([^"]+)"', c.get(url).get_data(as_text=True)).group(1)

        def enviar(url, conteudo, nome, **extra):
            return c.post(url, content_type="multipart/form-data", data={
                "csrf_token": token(url), "arquivo": (io.BytesIO(conteudo), nome), **extra})

        # telas e modelos
        for url in ("/produtos/importar", "/clientes/importar"):
            self.assertIn("Baixe o modelo", c.get(url).get_data(as_text=True))
        self.assertIn("Importar planilha", c.get("/produtos").get_data(as_text=True))
        self.assertIn("Importar planilha", c.get("/clientes").get_data(as_text=True))
        for grupo, formato, inicio in (("produtos", "csv", b"\xef\xbb\xbfcodigo;"), ("clientes", "csv", b"\xef\xbb\xbfdocumento;"),
                                       ("produtos", "xlsx", b"PK"), ("clientes", "xlsx", b"PK")):
            r = c.get(f"/{grupo}/modelo.{formato}")
            self.assertEqual(r.status_code, 200)
            self.assertTrue(r.data.startswith(inicio), (grupo, formato))
            self.assertIn("attachment", r.headers["Content-Disposition"])
        # produtos: simulação e gravação
        csv_ = b"codigo;descricao;ncm;preco\nW1;Produto web;61091000;12,34\nW2;Sem NCM;;1,00\n"
        r = enviar("/produtos/importar", csv_, "p.csv", simular="1")
        html = r.get_data(as_text=True)
        self.assertIn("Simulação concluída", html)
        self.assertNotIn("Produto web", c.get("/produtos").get_data(as_text=True))
        r = enviar("/produtos/importar", csv_, "p.csv")
        html = r.get_data(as_text=True)
        self.assertIn("Importação concluída", html)
        self.assertIn("NCM deve ter 8 dígitos", html)
        self.assertIn("Salvos como incompletos", html)
        self.assertIn("Sem NCM", c.get("/produtos?filtro=pendentes").get_data(as_text=True))
        self.assertNotIn("Produto web", c.get("/produtos?filtro=pendentes").get_data(as_text=True))
        self.assertIn("Produto web", c.get("/produtos").get_data(as_text=True))
        # clientes (CEP simulado) e arquivo ruim
        cli = (b"documento;nome;cep;logradouro;numero;bairro\n12345678909;Cliente Web;13201000;Rua W;5;Centro\n")
        with mock.patch("app.integracoes.importador.consultar_cep",
                        return_value={"localidade": "Jundiaí", "uf": "SP", "ibge": "3525904"}):
            html = enviar("/clientes/importar", cli, "c.csv").get_data(as_text=True)
        self.assertIn("Importação concluída", html)
        self.assertIn("Cliente Web", c.get("/clientes").get_data(as_text=True))
        self.assertIn("coluna de identificação", enviar("/produtos/importar", b"a;b\n1;2\n", "x.csv").get_data(as_text=True))
        self.assertIn("Excel antigo", enviar("/produtos/importar", b"\xd0\xcf\x11\xe0" + b"0" * 30, "x.xls").get_data(as_text=True))
        # sem CSRF não grava
        self.assertEqual(c.post("/produtos/importar", content_type="multipart/form-data",
                                data={"arquivo": (io.BytesIO(csv_), "p.csv")}).status_code, 400)

    def test_salvar_incompleto_nos_formularios(self):
        c = self.cliente(conta="conta-incompleto-aaaaaaaa")

        def token(url):
            return re.search(r'name="csrf_token" value="([^"]+)"', c.get(url).get_data(as_text=True)).group(1)

        # produto: sem o botão, os erros bloqueiam; com "Salvar incompleto", grava e marca pendente
        dados = {"csrf_token": token("/produtos/novo"), "codigo": "INC1", "descricao": "Produto incompleto",
                 "ncm": "123", "cfop": "5102", "cst_icms": "102", "preco": "5"}
        r = c.post("/produtos/novo", data=dados)
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("INC1", c.get("/produtos").get_data(as_text=True))
        r = c.post("/produtos/novo", data={**dados, "incompleto": "1"}, follow_redirects=True)
        html = r.get_data(as_text=True)
        self.assertIn("INCOMPLETO", html)
        self.assertIn("incompleto</span>", html)
        # completar limpa a pendência
        pid = re.search(r"/produtos/(\d+)\">completar", html).group(1)
        self.assertIn("NCM deve ter 8 dígitos", c.get(f"/produtos/{pid}").get_data(as_text=True))
        c.post(f"/produtos/{pid}", data={**dados, "csrf_token": token(f"/produtos/{pid}"), "ncm": "61091000"})
        html = c.get("/produtos").get_data(as_text=True)
        self.assertNotIn("incompleto</span>", html)
        self.assertIn("INC1", html)
        # cliente: só o nome já permite salvar incompleto
        r = c.post("/clientes/novo", data={"csrf_token": token("/clientes/novo"), "nome": "So o Nome",
                                           "incompleto": "1"}, follow_redirects=True)
        html = r.get_data(as_text=True)
        self.assertIn("So o Nome", html)
        self.assertIn("1 cliente(s) com cadastro incompleto", html)

    def test_banco_antigo_ganha_colunas_de_pendencia(self):
        import sqlite3
        from app.db import migrar
        con = sqlite3.connect(":memory:")
        con.executescript("CREATE TABLE produtos (id INTEGER PRIMARY KEY, codigo TEXT, descricao TEXT, ncm TEXT);"
                          "CREATE TABLE clientes (id INTEGER PRIMARY KEY, documento TEXT, nome TEXT);"
                          "INSERT INTO produtos (codigo, descricao, ncm) VALUES ('A','a','61091000'),('B','b','');"
                          "INSERT INTO clientes (documento, nome) VALUES ('1','x');")
        migrar(con)
        migrar(con)                                           # idempotente
        self.assertEqual([r[0] for r in con.execute("SELECT pendente FROM produtos ORDER BY id")], [0, 1])
        self.assertEqual(con.execute("SELECT pendente FROM clientes").fetchone()[0], 0)

    def test_busca_cliente_produto_na_nota(self):
        """Campos Cliente/Produto da nota: busca no servidor (não embute milhares de <option> na página)."""
        import sqlite3
        c = self.cliente(conta="conta-busca-aaaaaaaa")
        c.get("/")                                        # cria a conta/banco
        con = sqlite3.connect(Path(TMP) / "contas" / "conta-busca-aaaaaaaa" / "nfe.db")
        con.executemany("INSERT INTO clientes (documento,nome,cep,logradouro,numero,bairro,municipio,uf,cod_municipio) "
                        "VALUES (?,?,?,?,?,?,?,?,?)",
                        [(f"{10000000000 + i}", f"Cliente {i} Ltda", "13201000", "Rua", "1", "Centro", "Jundiai", "SP", "3525904")
                         for i in range(3000)] +
                        [("52998224725", "JOÃO da Conceição", "13201000", "Rua", "1", "Centro", "Jundiai", "SP", "3525904")])
        con.executemany("INSERT INTO produtos (codigo,descricao,ncm,preco,ativo) VALUES (?,?,?,?,?)",
                        [(f"P{i}", f"Produto {i}", "61091000", "9.90", 1) for i in range(3000)] +
                        [("CAFE-1", "Café torrado 500g", "09012100", "25.50", 1), ("OLD-1", "Café antigo", "09012100", "1.00", 0)])
        con.commit()
        con.close()
        # a página não carrega os cadastros (antes: 1 <option> por cliente/produto, repetido em cada item)
        html = c.get("/notas/nova").get_data(as_text=True)
        self.assertLess(len(html), 60_000)
        self.assertNotIn("Cliente 1500 Ltda", html)
        self.assertIn('data-url="/api/busca/clientes"', html)
        self.assertIn('data-url="/api/busca/produtos"', html)
        self.assertNotIn("Cadastre ao menos um", html)
        # cliente: sem acento, sem maiúsculas, CPF com/sem pontuação, rótulo colado, limite de resultados
        busca = lambda url: c.get(url).get_json()
        for q in ("joao conceicao", "JOÃO", "529.982.247-25", "52998224725", "João da Conceição (52998224725)"):
            itens = busca("/api/busca/clientes?q=" + q)["itens"]
            self.assertEqual([i["rotulo"] for i in itens], ["JOÃO da Conceição (52998224725)"], q)
        r = busca("/api/busca/clientes?q=cliente")
        self.assertEqual((len(r["itens"]), r["mais"]), (50, True))
        self.assertEqual(busca("/api/busca/clientes?q=ninguem")["itens"], [])
        # produto: código, descrição sem acento, NCM; ativos primeiro; devolve o preço
        r = busca("/api/busca/produtos?q=cafe")["itens"]
        self.assertEqual([i["rotulo"] for i in r], ["CAFE-1 - Café torrado 500g", "OLD-1 - Café antigo (inativo)"])
        self.assertEqual(r[0]["preco"], "25.50")
        self.assertEqual(len(busca("/api/busca/produtos?q=09012100")["itens"]), 2)
        self.assertEqual(busca("/api/busca/produtos?q=p2999")["itens"][0]["rotulo"], "P2999 - Produto 2999")
        # exige login do Turbo Prospect (sem cabeçalhos assinados é recusado)
        self.assertEqual(self.app.test_client().get("/api/busca/clientes?q=a").status_code, 403)
        # salvar a nota com os ids escolhidos continua igual; ao reabrir, os textos escolhidos voltam
        cid = busca("/api/busca/clientes?q=joao")["itens"][0]["id"]
        pid = busca("/api/busca/produtos?q=cafe-1")["itens"][0]["id"]
        tok = re.search(r'name="csrf_token" value="([^"]+)"', html).group(1)
        r = c.post("/notas/nova", data={"csrf_token": tok, "cliente_id": cid, "nat_op": "VENDA", "produto_id": [pid],
                                        "quantidade": ["2"], "valor_unitario": ["25,50"], "ind_final": "1", "ind_pres": "2",
                                        "ind_intermed": "0", "mod_frete": "9", "forma_pagto": "17",
                                        "valor_frete": "0", "valor_desconto": "0", "valor_outras": "0"})
        self.assertEqual(r.status_code, 302, r.get_data(as_text=True)[:400])
        nota_id = r.headers["Location"].rstrip("/").split("/")[-1]
        ed = c.get(f"/notas/{nota_id}/editar").get_data(as_text=True)
        self.assertIn("JOÃO da Conceição (52998224725)", ed)
        self.assertIn("CAFE-1 - Café torrado 500g", ed)
        # erro de validação reabre o formulário com as escolhas preservadas
        r = c.post(f"/notas/{nota_id}/editar", data={"csrf_token": tok, "cliente_id": cid, "produto_id": [pid],
                                                     "quantidade": ["0"], "valor_unitario": ["1"]})
        self.assertEqual(r.status_code, 200)
        self.assertIn("quantidade deve ser maior que zero", r.get_data(as_text=True))
        self.assertIn("CAFE-1 - Café torrado 500g", r.get_data(as_text=True))

    def test_somente_leitura_e_cota(self):
        c = self.cliente(conta="conta-ro-aaaaaaaa", leitura="1")
        self.assertEqual(c.get("/notas").status_code, 200)                       # consulta liberada
        self.assertEqual(c.post("/configuracoes", data={"cnpj": "x"}).status_code, 403)  # alteração bloqueada
        from app import create_app  # noqa: F401
        with self.app.test_request_context("/"):
            from flask import g
            from app import tenant
            from app.db import get_db
            g.conta, g.limite_mensal = "conta-cota-aaaaaaaa", 1
            tenant.preparar(g.conta)
            db = get_db()
            self.assertIsNone(tenant.erro_de_cota(db, "2"))                      # homologação nunca conta
            self.assertIsNone(tenant.erro_de_cota(db, "1"))                      # 0 de 1
            db.execute("INSERT INTO notas (ambiente, status, nat_op, dh_autorizacao) VALUES ('1','autorizada','x',?)",
                       (f"{tenant.periodo_atual()}-05T10:00:00-03:00",))
            db.commit()
            self.assertIn("Limite de 1 nota", tenant.erro_de_cota(db, "1"))      # 1 de 1: bloqueia
            g.limite_mensal = None
            self.assertIsNone(tenant.erro_de_cota(db, "1"))                      # plano sem limite

    # ---- aba Configurações (o nome começa com zz para rodar depois do fluxo completo) ----
    def _login(self):
        """Sem login próprio: o Turbo Prospect autentica (cabeçalhos assinados já vão no cliente de teste)."""

    def _salvar_config(self, crt):
        return self.post("/configuracoes", {
            "cnpj": CNPJ_EMPRESA, "razao_social": "EMPRESA TESTE LTDA", "ie": "111222333444", "crt": crt,
            "cep": "13201000", "logradouro": "Rua das Flores", "numero": "100", "bairro": "Centro",
            "municipio": "Jundiai", "cod_municipio": "3525904", "uf": "SP", "ambiente": "2", "serie": "1"},
            token_de="/configuracoes")

    def test_zz_configuracoes_regime(self):
        self._login()
        html = self.c.get("/configuracoes").get_data(as_text=True)
        self.assertIn("Configurações", html)
        self.assertIn("Regime tributário", html)
        self.assertEqual(self.c.get("/empresa").status_code, 302)   # endereço antigo redireciona

        self.post("/produtos/novo", {"codigo": "CFG-1", "descricao": "Produto Config", "ncm": "61091000",
                                     "cfop": "5102", "cst_icms": "102", "preco": "10"})
        self._salvar_config("1")                                      # Simples Nacional
        r = self._salvar_config("3")                                  # troca para regime normal
        txt = r.get_data(as_text=True)
        self.assertIn("Regime tributário alterado", txt)
        self.assertIn("incompatível", txt)                            # produtos com CSOSN 102
        self.assertIn("só o básico", txt)
        r = self._salvar_config("1")                                  # volta ao Simples
        txt = r.get_data(as_text=True)
        self.assertIn("Regime tributário alterado", txt)
        self.assertNotIn("incompatível", txt)
        r = self._salvar_config("1")                                  # sem mudança: sem aviso
        self.assertNotIn("Regime tributário alterado", r.get_data(as_text=True))

    def test_zz_configuracoes_urls_da_sefaz(self):
        self._login()
        self._salvar_config("1")
        self.post("/configuracoes/certificado", {"senha_certificado": SENHA_PFX, "certificado": (
            io.BytesIO(gerar_pfx()), "cert.pfx")}, token_de="/configuracoes",
            content_type="multipart/form-data")
        em_branco = {f"url_{a}_{s}": "" for a in "12" for s in SERVICOS}

        # endereço fora de .gov.br ou sem https é recusado e não é gravado
        for ruim in ("https://evil.example.com/ws", "http://nfe.fazenda.sp.gov.br/ws", "ftp://x.gov.br/"):
            r = self.post("/configuracoes/sefaz", {**em_branco, "url_2_NFeStatusServico4": ruim},
                          token_de="/configuracoes")
            self.assertIn("site .gov.br", r.get_data(as_text=True))
        self.assertNotIn("evil.example.com", self.c.get("/configuracoes").get_data(as_text=True))

        # endereço válido é salvo, aparece como alterado e é o usado na chamada à SEFAZ
        novo = "https://homologacao.nfe.fazenda.sp.gov.br/ws/outro.asmx"
        r = self.post("/configuracoes/sefaz", {**em_branco, "url_2_NFeStatusServico4": novo},
                      token_de="/configuracoes")
        html = r.get_data(as_text=True)
        self.assertIn("Endereços da SEFAZ salvos", html)
        self.assertIn(novo, html)
        self.assertIn("(alterado)", html)
        usado = {}

        def falso_post(url, data, headers, cert, timeout):
            usado["url"] = url
            return _RespStatus()
        sessao_falsa = mock.Mock(post=falso_post)
        with mock.patch.object(sefaz.tls, "sessao", return_value=sessao_falsa):
            r = self.post("/configuracoes/testar", {}, token_de="/configuracoes")
        self.assertEqual(usado["url"], novo)
        self.assertIn("107", r.get_data(as_text=True))

        # campo em branco volta ao padrão de fábrica
        r = self.post("/configuracoes/sefaz", {**em_branco}, token_de="/configuracoes")
        self.assertNotIn("(alterado)", r.get_data(as_text=True))
        with mock.patch.object(sefaz.tls, "sessao", return_value=sessao_falsa):
            self.post("/configuracoes/testar", {}, token_de="/configuracoes")
        self.assertEqual(usado["url"], "https://homologacao.nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx")

    def test_zz_cadeia_icp_brasil_na_tela(self):
        from app.nfe import tls as _tls
        html = self.c.get("/configuracoes").get_data(as_text=True)
        self.assertIn("Baixar cadeia ICP-Brasil", html)
        with mock.patch.object(_tls, "baixar_cadeia", return_value=7):
            r = self.post("/configuracoes/cadeia", {}, token_de="/configuracoes")
        self.assertIn("Cadeia ICP-Brasil instalada (7 certificados)", r.get_data(as_text=True))
        with mock.patch.object(_tls, "baixar_cadeia", side_effect=_tls.CadeiaErro("sem internet")):
            r = self.post("/configuracoes/cadeia", {}, token_de="/configuracoes")
        self.assertIn("sem internet", r.get_data(as_text=True))


# ---------------------------------------------------------------------------------------
# Integrações com lojas (respostas simuladas no formato descrito na documentação de cada API)
# ---------------------------------------------------------------------------------------
CPF_OK = "52998224725"


class TestImportacao(unittest.TestCase):
    """Importação de clientes e produtos por CSV/Excel (sem rede: o CEP é simulado)."""

    def setUp(self):
        import sqlite3
        from app.db import SCHEMA
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    @staticmethod
    def cep_falso(cep):
        base = {"logradouro": "Rua do CEP", "bairro": "Centro", "localidade": "Jundiaí", "uf": "SP", "ibge": "3525904"}
        return {} if cep == "99999999" else base

    def ler(self, tipo, nome, dados):
        from app import importacao
        return importacao.ler_registros(tipo, nome, dados)

    def importar(self, tipo, nome, dados, **kw):
        from app import importacao
        regs, ign = importacao.ler_registros(tipo, nome, dados)
        kw.setdefault("cep_fn", self.cep_falso)
        return importacao.aplicar(self.db, tipo, regs, ignoradas=ign, **kw)

    def test_produtos_csv_br(self):
        # Excel brasileiro: ponto e vírgula, ANSI (cp1252), vírgula decimal, nomes de coluna variados
        csv_ = ("SKU;Descrição;NCM;Valor;Un;CSOSN\r\n"
                "A-1;Camisa básica;61091000;49,90;un;102\r\n"
                "A-2;Livro de açúcar;1012100;1.234,56;;102\r\n"          # NCM sem o zero da frente
                "A-3;Sem NCM;;10,00;;102\r\n"
                "A-4;CST inválido;61091000;10,00;;999\r\n"
                "A-5;Preço ruim;61091000;abc;;102\r\n").encode("cp1252")
        r = self.importar("produto", "produtos.csv", csv_, crt="1")
        # nada é descartado: as 3 linhas com problema ficam salvas como INCOMPLETAS para editar depois
        self.assertEqual((r.total, r.criados, r.com_erro, r.pendentes), (5, 5, 0, 3))
        self.assertEqual([l for l, _ in r.incompletos], [4, 5, 6])        # número da linha na planilha
        pend = {c: (p, t) for c, p, t in self.db.execute("SELECT codigo, pendente, pendencias FROM produtos")}
        self.assertEqual([c for c, (p, _) in pend.items() if p], ["A-3", "A-4", "A-5"])
        self.assertIn("NCM", pend["A-3"][1])
        self.assertIn("CST/CSOSN", pend["A-4"][1])
        self.assertIn("Preço", pend["A-5"][1])
        a4 = self.db.execute("SELECT cst_icms, preco FROM produtos WHERE codigo='A-5'").fetchone()
        self.assertEqual((a4["cst_icms"], a4["preco"]), ("102", "0.00"))   # valor ruim vira o padrão
        a2 = self.db.execute("SELECT * FROM produtos WHERE codigo='A-2'").fetchone()
        self.assertEqual((a2["ncm"], a2["preco"], a2["cfop"], a2["unidade"]), ("01012100", "1234.56", "5102", "UN"))
        self.assertEqual(self.db.execute("SELECT unidade FROM produtos WHERE codigo='A-1'").fetchone()[0], "UN")

    def test_produtos_atualizar_sem_apagar(self):
        self.importar("produto", "a.csv", b"codigo;descricao;ncm;preco;cfop;cest\nP1;Antigo;61091000;10,00;5405;2800100\n")
        # só preço e descrição vêm na planilha; CFOP e CEST não podem ser perdidos; célula vazia não apaga
        r = self.importar("produto", "b.csv", b"codigo;descricao;ncm;preco;cest\nP1;Novo nome;;25,50;\n")
        self.assertEqual((r.criados, r.atualizados, r.com_erro), (0, 1, 0))
        p = self.db.execute("SELECT * FROM produtos WHERE codigo='P1'").fetchone()
        self.assertEqual((p["descricao"], p["preco"], p["cfop"], p["cest"], p["ncm"]),
                         ("Novo nome", "25.50", "5405", "2800100", "61091000"))
        # modo "pular" não mexe em nada
        r = self.importar("produto", "c.csv", b"codigo;descricao;ncm\nP1;Outro;61091000\n", existentes="pular")
        self.assertEqual((r.ignorados, r.atualizados), (1, 0))
        self.assertEqual(self.db.execute("SELECT descricao FROM produtos WHERE codigo='P1'").fetchone()[0], "Novo nome")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM produtos").fetchone()[0], 1)

    def test_produtos_xlsx_numeros_do_excel(self):
        from openpyxl import Workbook
        wb = Workbook()
        ws = wb.active
        ws.append(["Código", "Produto", "NCM", "Preço de venda", "GTIN", "CST ICMS", "Origem"])
        ws.append([1001, "Tênis esportivo", 64041100, 199.9, 7891234567895, 102, 0])     # tudo numérico
        ws.append(["X-7", "Chapéu", 1012100, 19.99, 78912345678, 102, 1])                 # EAN-12 sem o zero? 11 dígitos
        ws.append([None, None, None, None, None, None, None])                             # linha em branco
        buf = io.BytesIO()
        wb.save(buf)
        r = self.importar("produto", "planilha.xlsx", buf.getvalue(), crt="1")
        self.assertEqual((r.total, r.criados, r.com_erro), (2, 2, 0), r.erros)
        p = self.db.execute("SELECT * FROM produtos WHERE codigo='1001'").fetchone()
        self.assertEqual((p["ncm"], p["preco"], p["ean"], p["cst_icms"]), ("64041100", "199.9", "7891234567895", "102"))
        self.assertEqual(self.db.execute("SELECT ean, ncm, origem FROM produtos WHERE codigo='X-7'").fetchone()[:],
                         ("078912345678", "01012100", "1"))

    def test_produtos_regime_normal_cst_sem_zero(self):
        r = self.importar("produto", "n.csv", b"codigo;descricao;ncm;cst_icms\nN1;Normal;61091000;0\nN2;Isento;61091000;40\n",
                          crt="3")
        self.assertEqual((r.criados, r.com_erro), (2, 0), r.erros)
        self.assertEqual(self.db.execute("SELECT cst_icms FROM produtos WHERE codigo='N1'").fetchone()[0], "00")

    def test_clientes_csv_com_cep(self):
        csv_ = ("CPF/CNPJ;Nome;CEP;Endereço;Número;Bairro;Cidade;UF;Telefone;E-mail;IE\n"
                "123.456.789-09;Maria da Silva;13201000;Rua A;10;Centro;;;(11) 99999-8888;maria@x.com;\n"
                "11.222.333/0001-81;Loja Exemplo Ltda;1310100;Av. Paulista;1000;Bela Vista;;;;;111222333444\n"  # CEP sem 0
                "123.456.789-00;CPF inválido;13201000;Rua B;1;Centro;;;;;\n"
                "98765432100;Sem endereço;99999999;;;;;;;;\n"                                                   # CEP não achado
                "12345678909;Email ruim;13201000;Rua C;2;Centro;;;;email-sem-arroba;\n").encode("utf-8")
        r = self.importar("cliente", "clientes.csv", csv_)
        # 5ª linha repete o CPF da Maria: atualiza o cadastro dela, ignorando o e-mail inválido
        self.assertEqual((r.total, r.criados, r.atualizados, r.com_erro, r.pendentes), (5, 4, 1, 0, 2), r.erros)
        self.assertEqual([l for l, _ in r.ressalvas], [6])
        maria = self.db.execute("SELECT * FROM clientes WHERE documento='12345678909'").fetchone()
        self.assertEqual((maria["municipio"], maria["uf"], maria["cod_municipio"], maria["fone"], maria["ind_ie_dest"]),
                         ("Jundiaí", "SP", "3525904", "11999998888", "9"))
        loja = self.db.execute("SELECT * FROM clientes WHERE documento='11222333000181'").fetchone()
        self.assertEqual((loja["cep"], loja["ind_ie_dest"], loja["ie"]), ("01310100", "1", "111222333444"))
        erros = {linha: " ".join(msgs) for linha, msgs in r.incompletos}
        self.assertIn("CPF/CNPJ inválido", erros[4])
        self.assertIn("IBGE", erros[5])
        self.assertEqual(maria["email"], "maria@x.com")

    def test_clientes_atualizar_e_ie_isento(self):
        base = ("documento;nome;cep;logradouro;numero;bairro;municipio;uf;cod_municipio;ind_ie_dest;ie\n"
                "12345678909;Maria;13201000;Rua A;10;Centro;Jundiaí;SP;3525904;9;\n")
        self.importar("cliente", "a.csv", base.encode())
        r = self.importar("cliente", "b.csv", b"documento;nome;ie\n123.456.789-09;Maria Souza;ISENTO\n")
        self.assertEqual((r.criados, r.atualizados, r.com_erro), (0, 1, 0), r.erros)
        c = self.db.execute("SELECT * FROM clientes").fetchone()
        self.assertEqual((c["nome"], c["logradouro"], c["ind_ie_dest"], c["ie"]), ("Maria Souza", "Rua A", "2", ""))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM clientes").fetchone()[0], 1)
        # contribuinte sem IE: salvo, mas marcado como pendente
        r = self.importar("cliente", "c.csv", b"documento;nome;ind_ie_dest\n12345678909;Maria;contribuinte\n")
        self.assertIn("Inscrição Estadual", " ".join(r.incompletos[0][1]))
        self.assertEqual(self.db.execute("SELECT pendente FROM clientes").fetchone()[0], 1)

    def test_notacao_cientifica_e_zeros_do_documento(self):
        r = self.importar("cliente", "n.csv", ("documento;nome;cep;logradouro;numero;bairro\n"
                                                "1,12345678909E+10;Teste;13201000;Rua A;1;Centro\n"
                                                "1234567890;CPF sem zero;13201000;Rua A;1;Centro\n").encode())
        self.assertIn("notação científica", " ".join(r.incompletos[0][1]))

    def test_cabecalho_fora_da_primeira_linha_e_formatos_livres(self):
        csv_ = ("Lista de produtos da loja\n\nCódigo;Nome do Produto;Preço;Unidade;NCM\n"
                "Z1;Meia;R$ 12,50;Unidade;61159500\n").encode("utf-8")
        r = self.importar("produto", "x.csv", csv_)
        self.assertEqual((r.criados, r.pendentes), (1, 0), r.incompletos)
        p = self.db.execute("SELECT * FROM produtos").fetchone()
        self.assertEqual((p["preco"], p["unidade"], p["pendente"]), ("12.50", "UN", 0))

    def test_produto_sem_codigo_ganha_codigo_automatico(self):
        csv_ = b"descricao;ncm\nCaneca azul;69120000\n"
        r1 = self.importar("produto", "a.csv", csv_)
        r2 = self.importar("produto", "a.csv", csv_)             # reimportar não duplica
        self.assertEqual((r1.criados, r1.codigos_automaticos, r2.atualizados), (1, 1, 1))
        self.assertTrue(self.db.execute("SELECT codigo FROM produtos").fetchone()[0].startswith("IMP-"))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM produtos").fetchone()[0], 1)

    def test_linha_sem_identificacao_nao_e_salva(self):
        r = self.importar("produto", "a.csv", b"codigo;descricao;ncm\n;;61091000\nOK;Item;61091000\n")
        self.assertEqual((r.criados, r.com_erro), (1, 1))
        r = self.importar("cliente", "b.csv", b"documento;nome;cep\n;;13201000\n")
        self.assertEqual((r.criados, r.com_erro), (0, 1))

    def test_cliente_sem_documento_fica_pendente_e_nao_duplica(self):
        csv_ = b"nome;cep;logradouro;numero;bairro\nJoao Sem CPF;13201000;Rua A;1;Centro\n"
        r1 = self.importar("cliente", "a.csv", csv_)
        r2 = self.importar("cliente", "a.csv", csv_)
        self.assertEqual((r1.criados, r1.pendentes, r2.atualizados), (1, 1, 1))
        c = self.db.execute("SELECT * FROM clientes").fetchone()
        self.assertEqual((c["documento"], c["pendente"]), ("", 1))
        self.assertIn("não informado", c["pendencias"])

    def test_completar_pendente_pela_planilha_limpa_a_pendencia(self):
        self.importar("produto", "a.csv", b"codigo;descricao\nP9;Sem NCM\n")
        self.assertEqual(self.db.execute("SELECT pendente FROM produtos").fetchone()[0], 1)
        # modo "pular" não pode impedir de completar um cadastro pendente
        r = self.importar("produto", "b.csv", b"codigo;ncm\nP9;61091000\n", existentes="pular")
        self.assertEqual(r.atualizados, 1)
        p = self.db.execute("SELECT * FROM produtos").fetchone()
        self.assertEqual((p["pendente"], p["pendencias"], p["descricao"], p["ncm"]), (0, "", "Sem NCM", "61091000"))

    def test_valor_ruim_nao_estraga_cadastro_existente(self):
        self.importar("produto", "a.csv", b"codigo;descricao;ncm;cfop\nP1;Bom;61091000;5405\n")
        r = self.importar("produto", "b.csv", b"codigo;cfop;ncm\nP1;54;abc\n")
        p = self.db.execute("SELECT * FROM produtos").fetchone()
        self.assertEqual((p["cfop"], p["ncm"], p["pendente"]), ("5405", "61091000", 0))
        self.assertEqual(len(r.ressalvas), 1)

    def test_pendencias_de_cadastro_bloqueiam_emissao(self):
        from app import servico
        self.importar("produto", "a.csv", b"codigo;descricao\nP1;Sem NCM\n")
        self.importar("cliente", "c.csv", b"nome\nSem Documento\n")
        cli = dict(self.db.execute("SELECT * FROM clientes").fetchone())
        pid = self.db.execute("SELECT id FROM produtos").fetchone()[0]
        erros = servico._pendencias_cadastro(self.db, cli, [{"produto_id": pid}])
        self.assertEqual(len(erros), 2)
        self.assertIn("incompleto", erros[0] + erros[1])

    def test_simulacao_nao_grava(self):
        r = self.importar("produto", "s.csv", b"codigo;descricao;ncm\nS1;Simulado;61091000\n", simular=True)
        self.assertEqual((r.criados, r.simulado), (1, True))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM produtos").fetchone()[0], 0)

    def test_arquivos_invalidos(self):
        from app import importacao
        casos = {
            "vazio": b"",
            "sem coluna de identificação": b"preco;estoque\n1;2\n",
            "só cabeçalho": b"codigo;descricao;ncm\n",
            "xls antigo": b"\xd0\xcf\x11\xe0" + b"0" * 50,
            "xlsx corrompido": b"PK\x03\x04" + b"0" * 50,
        }
        for nome, dados in casos.items():
            with self.assertRaises(importacao.ArquivoInvalido, msg=nome):
                self.ler("produto", "arq.xls" if nome == "xls antigo" else "arq.csv", dados)
        linhas = "codigo;descricao;ncm\n" + "".join(f"S{i};Item;61091000\n" for i in range(importacao.MAX_LINHAS + 1))
        with self.assertRaises(importacao.ArquivoInvalido):
            self.ler("produto", "grande.csv", linhas.encode())

    def test_cep_limitado_nao_trava(self):
        from app import importacao
        chamadas = []

        def lento(cep):
            chamadas.append(cep)
            return self.cep_falso(cep)

        n = importacao.MAX_CONSULTAS_CEP + 20
        linhas = "documento;nome;cep;logradouro;numero;bairro\n"
        # CPFs válidos gerados: 11 dígitos com verificadores corretos
        def cpf(i):
            nove = [int(x) for x in f"{i:09d}"]
            for k in (9, 10):
                soma = sum(d * (k + 1 - j) for j, d in enumerate(nove))
                nove.append((soma * 10 % 11) % 10)
            return "".join(map(str, nove))
        for i in range(1, n + 1):
            linhas += f"{cpf(100000 + i)};Cliente {i};{13000000 + i:08d};Rua;1;Centro\n"
        r = self.importar("cliente", "m.csv", linhas.encode(), cep_fn=lento)
        self.assertLessEqual(len(chamadas), importacao.MAX_CONSULTAS_CEP)
        self.assertEqual(r.criados, n)                       # ninguém é perdido...
        self.assertEqual(r.pendentes, n - importacao.MAX_CONSULTAS_CEP)   # ...as sem IBGE ficam pendentes
        self.assertTrue(r.avisos)

    def test_modelos_sao_importaveis(self):
        from app import importacao
        for tipo in ("produto", "cliente"):
            for gerar, nome in ((importacao.modelo_csv, "m.csv"), (importacao.modelo_xlsx, "m.xlsx")):
                self.db.execute("DELETE FROM produtos")
                self.db.execute("DELETE FROM clientes")
                r = self.importar(tipo, nome, gerar(tipo))
                self.assertEqual((r.criados, r.com_erro), (2, 0), (tipo, nome, r.erros))


class _Resp:
    def __init__(self, dados, status=200):
        self._d, self.status_code = dados, status

    def json(self):
        return self._d


class _HttpFalso:
    """Substitui o requests: rotas = lista de (metodo, trecho_da_url, funcao(kw)->dados|(dados,status))."""
    def __init__(self, rotas):
        self.rotas, self.chamadas = rotas, []

    def _chamar(self, metodo, url, **kw):
        self.chamadas.append((metodo, url, kw))
        for m, trecho, fn in self.rotas:
            if m == metodo and trecho in url:
                r = fn(kw) if callable(fn) else fn
                return _Resp(*r) if isinstance(r, tuple) else _Resp(r)
        return _Resp({}, 404)

    def get(self, url, **kw):
        return self._chamar("get", url, **kw)

    def post(self, url, **kw):
        return self._chamar("post", url, **kw)


def _com_http(rotas):
    from app.integracoes import base
    falso = _HttpFalso(rotas)
    return falso, mock.patch.object(base, "http", falso)


PED_NUVEM = {"id": 777, "number": 1001, "created_at": "2026-11-20T10:00:00+0000", "payment_status": "paid",
             "contact_name": "Maria da Silva", "contact_email": "maria@exemplo.com",
             "contact_phone": "+5511999998888", "contact_identification": "529.982.247-25",
             "shipping_address": {"address": "Rua das Acacias", "number": "45", "floor": "ap 2",
                                  "locality": "Centro", "city": "Jundiai", "province": "Sao Paulo",
                                  "zipcode": "13201000"},
             "products": [{"name": "Camiseta Azul", "sku": "CAM-AZ", "quantity": 2, "price": "50.00"},
                          {"name": "Item sem cadastro", "sku": "NOVO-1", "quantity": 1, "price": "10.00"}],
             "subtotal": "110.00", "discount": "10.00", "shipping_cost_customer": "15.00", "total": "115.00",
             "gateway": "pix", "note": ""}


class TestConectores(unittest.TestCase):
    def test_nuvemshop(self):
        from app.integracoes import nuvemshop
        falso, p = _com_http([("get", "/v1/123/orders", lambda kw: [PED_NUVEM] if kw["params"]["page"] == 1 else [])])
        with p:
            r = nuvemshop.buscar({"store_id": "123", "access_token": "tok"}, 10)
        ped = r[0]
        self.assertEqual(ped["cliente"]["documento"], CPF_OK)
        self.assertEqual(ped["cliente"]["logradouro"], "Rua das Acacias")
        self.assertEqual(ped["itens"][0]["sku"], "CAM-AZ")
        self.assertEqual((ped["frete"], ped["desconto"], ped["pagamento"]), ("15.00", "10.00", "17"))
        cab = falso.chamadas[0][2]["headers"]
        self.assertIn("bearer tok", cab["Authentication"])
        self.assertTrue(cab["User-Agent"])
        with self.assertRaises(Exception):
            nuvemshop.buscar({"store_id": "abc", "access_token": "x"})

    def test_woocommerce(self):
        from app.integracoes import woocommerce
        o = {"id": 55, "number": "55", "status": "processing", "date_created": "2026-11-20T10:00:00",
             "total": "120.00", "discount_total": "0.00", "shipping_total": "20.00",
             "payment_method": "pagarme-credit-card", "payment_method_title": "Cartao",
             "customer_note": "",
             "billing": {"first_name": "Joao", "last_name": "Souza", "company": "", "address_1": "Av Brasil, 1000",
                         "address_2": "", "city": "Campinas", "state": "SP", "postcode": "13010-000",
                         "country": "BR", "email": "j@x.com", "phone": "1999"},
             "shipping": {"address_1": "", "city": "", "state": "", "postcode": ""},
             "meta_data": [{"id": 1, "key": "_billing_cpf", "value": "529.982.247-25"},
                           {"id": 2, "key": "_billing_neighborhood", "value": "Bonfim"}],
             "line_items": [{"name": "Caneca", "sku": "CAN-1", "quantity": 2, "price": 50, "subtotal": "100.00",
                             "total": "100.00", "product_id": 9}]}
        cancelado = {**o, "id": 56, "status": "cancelled"}
        falso, p = _com_http([("get", "/wp-json/wc/v3/orders", [o, cancelado])])
        with p:
            r = woocommerce.buscar({"url": "https://loja.exemplo.com", "consumer_key": "ck", "consumer_secret": "cs"})
        self.assertEqual(len(r), 1)                       # cancelado ignorado
        self.assertEqual(r[0]["cliente"]["documento"], CPF_OK)
        self.assertEqual((r[0]["cliente"]["logradouro"], r[0]["cliente"]["numero"], r[0]["cliente"]["bairro"]),
                         ("Av Brasil", "1000", "Bonfim"))
        self.assertEqual(r[0]["itens"][0]["preco"], "50.00")
        self.assertEqual(r[0]["pagamento"], "03")
        self.assertEqual(falso.chamadas[0][2]["auth"], ("ck", "cs"))
        from app.integracoes.base import ErroIntegracao
        for ruim in ("http://loja.com", "https://127.0.0.1", "https://localhost"):
            with self.assertRaises(ErroIntegracao):
                woocommerce.buscar({"url": ruim, "consumer_key": "a", "consumer_secret": "b"})

    def test_shopify(self):
        from app.integracoes import shopify
        no = {"id": "gid://shopify/Order/9001", "name": "#1042", "createdAt": "2026-11-20T10:00:00Z",
              "email": "a@b.com", "phone": None, "note": "CPF: 529.982.247-25", "displayFinancialStatus": "PAID",
              "paymentGatewayNames": ["shopify_payments"], "customAttributes": [],
              "customer": {"firstName": "Ana", "lastName": "Lima", "email": "a@b.com", "phone": "+5511"},
              "billingAddress": {"name": "Ana Lima", "company": None, "phone": None},
              "shippingAddress": {"name": "Ana Lima", "company": None, "phone": "+5511", "address1": "Rua Verde, 12",
                                  "address2": "", "city": "Sao Paulo", "provinceCode": "SP", "zip": "01001000"},
              "totalDiscountsSet": {"shopMoney": {"amount": "5.00", "currencyCode": "BRL"}},
              "totalShippingPriceSet": {"shopMoney": {"amount": "12.00", "currencyCode": "BRL"}},
              "totalPriceSet": {"shopMoney": {"amount": "107.00", "currencyCode": "BRL"}},
              "lineItems": {"nodes": [{"name": "Tenis", "sku": "TEN-1", "quantity": 1,
                                       "originalUnitPriceSet": {"shopMoney": {"amount": "100.00"}}}]}}
        falso, p = _com_http([("post", "myshopify.com/admin/api/2026-07/graphql.json",
                               {"data": {"orders": {"pageInfo": {"hasNextPage": False, "endCursor": None},
                                                    "nodes": [no]}}})])
        with p:
            r = shopify.buscar({"loja": "minhaloja.myshopify.com", "access_token": "shpat_x"})
        self.assertEqual(r[0]["externo_id"], "9001")
        self.assertEqual(r[0]["cliente"]["documento"], CPF_OK)
        self.assertEqual((r[0]["cliente"]["logradouro"], r[0]["cliente"]["numero"]), ("Rua Verde", "12"))
        self.assertEqual(r[0]["frete"], "12.00")
        self.assertEqual(falso.chamadas[0][2]["headers"]["X-Shopify-Access-Token"], "shpat_x")
        from app.integracoes.base import ErroIntegracao
        with self.assertRaises(ErroIntegracao):
            shopify.buscar({"loja": "evil.com", "access_token": "x"})

    def test_mercadolivre_renova_token_e_busca_documento(self):
        from app.integracoes import mercadolivre as ml
        ordem = {"id": 2000012345, "date_created": "2026-11-20T10:00:00.000-03:00", "status": "paid",
                 "total_amount": 130.0,
                 "buyer": {"id": 1, "nickname": "COMPRADOR1", "first_name": "Carla", "last_name": "Dias"},
                 "order_items": [{"item": {"id": "MLB1", "title": "Fone", "seller_custom_field": "FONE-1"},
                                  "quantity": 1, "unit_price": 120.0}],
                 "payments": [{"payment_type": "credit_card"}],
                 "shipping": {"id": 555, "cost": 10}}
        falso, p = _com_http([
            ("post", "/oauth/token", {"access_token": "NOVO", "refresh_token": "R2", "expires_in": 21600,
                                      "user_id": 42}),
            ("get", "/orders/search", {"paging": {"total": 1, "offset": 0, "limit": 50}, "results": [ordem]}),
            ("get", "/billing_info", {"billing_info": {"doc_type": "CPF", "doc_number": "52998224725",
                                                       "name": "Carla", "last_name": "Dias"}}),
            ("get", "/shipments/555", {"receiver_address": {"zip_code": "13201000", "street_name": "Rua Lima",
                                                            "street_number": "7", "city": {"name": "Jundiai"},
                                                            "state": {"id": "BR-SP"},
                                                            "neighborhood": {"name": "Centro"}}}),
        ])
        cfg = {"client_id": "1", "client_secret": "s", "refresh_token": "R1", "user_id": "42", "expira_em": 0}
        with p:
            r = ml.buscar(cfg)
        self.assertEqual(cfg["refresh_token"], "R2")               # refresh_token novo é guardado
        self.assertEqual(r[0]["cliente"]["documento"], CPF_OK)
        self.assertEqual((r[0]["cliente"]["uf"], r[0]["cliente"]["municipio"]), ("SP", "Jundiai"))
        self.assertEqual(r[0]["itens"][0]["sku"], "FONE-1")
        self.assertEqual(r[0]["pagamento"], "03")
        busca = [c for c in falso.chamadas if "/orders/search" in c[1]][0]
        self.assertEqual(busca[2]["headers"]["Authorization"], "Bearer NOVO")


class TestImportacaoWeb(unittest.TestCase):
    setUpClass = classmethod(TestAplicacaoWeb.setUpClass.__func__)
    CONTA, cabecalhos, cliente = TestAplicacaoWeb.CONTA, TestAplicacaoWeb.cabecalhos, TestAplicacaoWeb.cliente
    setUp, token, post = TestAplicacaoWeb.setUp, TestAplicacaoWeb.token, TestAplicacaoWeb.post
    _login, _salvar_config = TestAplicacaoWeb._login, TestAplicacaoWeb._salvar_config

    def test_zz_importar_pedidos(self):
        self._login()
        self._salvar_config("1")
        self.post("/produtos/novo", {"codigo": "CAM-AZ", "descricao": "Camiseta Azul", "ncm": "61091000",
                                     "cfop": "5102", "cst_icms": "102", "preco": "50"})
        self.post("/integracoes/nuvemshop", {"store_id": "123", "access_token": "tok-secreto"},
                  token_de="/integracoes")
        html = self.c.get("/integracoes").get_data(as_text=True)
        self.assertNotIn("tok-secreto", html)                       # segredo não volta para a tela
        with self.app.test_request_context("/"):
            from flask import g as _g
            _g.conta = self.CONTA
            from app.db import get_db
            bruto = get_db().execute("SELECT config_enc FROM integracoes").fetchone()[0]
            self.assertNotIn("tok-secreto", bruto)                   # e fica cifrado no banco

        sem_doc = {**PED_NUVEM, "id": 778, "number": 1002, "contact_identification": ""}
        novo_cli = {**PED_NUVEM, "id": 779, "number": 1003, "contact_identification": "111.444.777-35",
                    "contact_name": "Pedro Novo"}
        cep = {"logradouro": "Rua das Acacias", "bairro": "Centro", "localidade": "Jundiai", "uf": "SP",
               "ibge": "3525904"}
        falso, http = _com_http([("get", "/v1/123/orders", lambda kw: [PED_NUVEM, sem_doc, novo_cli] if kw["params"]["page"] == 1 else [])])
        with http, mock.patch("app.integracoes.importador.consultar_cep", return_value=cep):
            r = self.post("/integracoes/nuvemshop/importar", {"dias": "30"}, token_de="/integracoes")
            txt = r.get_data(as_text=True)
            self.assertIn("2 pedido(s) importado(s) como rascunho", txt)
            self.assertIn("sem CPF/CNPJ", txt)
            self.assertIn("criado sem NCM", txt)                     # SKU desconhecido
            r2 = self.post("/integracoes/nuvemshop/importar", {"dias": "30"}, token_de="/integracoes")
            self.assertIn("0 pedido(s) importado(s)", r2.get_data(as_text=True))
            self.assertIn("2 já importado(s)", r2.get_data(as_text=True))

        with self.app.test_request_context("/"):
            from flask import g as _g
            _g.conta = self.CONTA
            from app.db import get_db
            db = get_db()
            novo = db.execute("SELECT * FROM clientes WHERE documento = '11144477735'").fetchone()
            self.assertEqual((novo["cod_municipio"], novo["uf"], novo["numero"], novo["nome"]),
                             ("3525904", "SP", "45", "Pedro Novo"))
            ped = db.execute("SELECT * FROM pedidos_importados WHERE externo_id = '777'").fetchone()
            nota = db.execute("SELECT * FROM notas WHERE id = ?", (ped["nota_id"],)).fetchone()
            self.assertEqual(nota["status"], "rascunho")
            self.assertEqual(nota["valor_frete"], "15.00")
            self.assertEqual(nota["valor_desconto"], "10.00")
            self.assertEqual(nota["forma_pagto"], "17")
            self.assertEqual(nota["total_nf"], "115.00")
            itens = db.execute("SELECT * FROM nota_itens WHERE nota_id = ?", (nota["id"],)).fetchall()
            self.assertEqual([i["codigo"] for i in itens], ["CAM-AZ", "NOVO-1"])
            self.assertEqual(itens[0]["ncm"], "61091000")            # herdou o cadastro do produto
            self.assertEqual(db.execute("SELECT COUNT(*) FROM clientes WHERE documento = ?",
                                        (CPF_OK,)).fetchone()[0], 1)     # cliente existente é reaproveitado
            self.assertIsNotNone(db.execute("SELECT 1 FROM clientes WHERE id = ?", (nota["cliente_id"],)).fetchone())
            # excluir o rascunho libera o pedido para ser importado de novo
            db.execute("DELETE FROM notas WHERE id = ?", (nota["id"],))
            db.commit()
            self.assertEqual(db.execute("SELECT COUNT(*) FROM pedidos_importados WHERE externo_id = '777'"
                                        ).fetchone()[0], 0)

    def test_zz_ml_autorizacao_exige_state(self):
        self._login()
        r = self.c.get("/integracoes/mercadolivre/retorno?code=abc&state=falso", follow_redirects=True)
        self.assertIn("cancelada ou inválida", r.get_data(as_text=True))


if __name__ == "__main__":
    unittest.main(verbosity=2)

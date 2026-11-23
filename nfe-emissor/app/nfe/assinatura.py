"""Assinatura digital XMLDSig (enveloped, RSA-SHA1, C14N 1.0) exigida pela SEFAZ.

Implementado direto com lxml + cryptography (sem dependências extras).
O padrão da NF-e 4.00 ainda usa SHA-1 na assinatura.
"""
import base64
import hashlib

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding
from lxml import etree

from .certificado import Certificado

NS_DS = "http://www.w3.org/2000/09/xmldsig#"
ALG_C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315"
ALG_SIG = "http://www.w3.org/2000/09/xmldsig#rsa-sha1"
ALG_DIGEST = "http://www.w3.org/2000/09/xmldsig#sha1"
ALG_ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature"


def _ds(nome: str) -> str:
    return f"{{{NS_DS}}}{nome}"


def _c14n(elemento) -> bytes:
    return etree.tostring(elemento, method="c14n", exclusive=False, with_comments=False)


def assinar(pai, alvo, cert: Certificado):
    """Assina `alvo` (infNFe, infEvento...) e anexa o <Signature> como filho de `pai`.

    `alvo` precisa ter o atributo Id; o <Signature> fica logo depois dele, dentro de `pai`
    (NFe -> infNFe + Signature; evento -> infEvento + Signature).
    """
    ref_id = alvo.get("Id")
    if not ref_id:
        raise ValueError("Elemento a assinar não possui atributo Id.")

    sig = etree.SubElement(pai, _ds("Signature"), nsmap={None: NS_DS})
    signed_info = etree.SubElement(sig, _ds("SignedInfo"))
    etree.SubElement(signed_info, _ds("CanonicalizationMethod"), Algorithm=ALG_C14N)
    etree.SubElement(signed_info, _ds("SignatureMethod"), Algorithm=ALG_SIG)
    ref = etree.SubElement(signed_info, _ds("Reference"), URI=f"#{ref_id}")
    transforms = etree.SubElement(ref, _ds("Transforms"))
    etree.SubElement(transforms, _ds("Transform"), Algorithm=ALG_ENVELOPED)
    etree.SubElement(transforms, _ds("Transform"), Algorithm=ALG_C14N)
    etree.SubElement(ref, _ds("DigestMethod"), Algorithm=ALG_DIGEST)
    digest_value = etree.SubElement(ref, _ds("DigestValue"))
    signature_value = etree.SubElement(sig, _ds("SignatureValue"))
    key_info = etree.SubElement(sig, _ds("KeyInfo"))
    x509_data = etree.SubElement(key_info, _ds("X509Data"))
    x509_cert = etree.SubElement(x509_data, _ds("X509Certificate"))
    x509_cert.text = cert.cert_der_base64()

    digest_value.text = base64.b64encode(hashlib.sha1(_c14n(alvo)).digest()).decode()
    assinatura = cert.chave_privada.sign(_c14n(signed_info), padding.PKCS1v15(), hashes.SHA1())
    signature_value.text = base64.b64encode(assinatura).decode()
    return sig


def verificar(elemento_raiz) -> bool:
    """Confere digest e assinatura de um XML já assinado (usado nos testes e na emissão).

    Só prova que a assinatura é coerente com o certificado embutido; quem valida de fato
    (cadeia ICP-Brasil, validade etc.) é a SEFAZ.
    """
    from cryptography import x509

    ns = {"ds": NS_DS}
    sig = elemento_raiz.find(".//ds:Signature", ns)
    if sig is None:
        return False
    ref = sig.find("ds:SignedInfo/ds:Reference", ns)
    uri = ref.get("URI", "")[1:]
    alvo = next((e for e in elemento_raiz.iter() if e.get("Id") == uri), None)
    if alvo is None:
        return False
    digest_esperado = base64.b64encode(hashlib.sha1(_c14n(alvo)).digest()).decode()
    if ref.findtext("ds:DigestValue", namespaces=ns) != digest_esperado:
        return False
    cert_der = base64.b64decode(sig.findtext(".//ds:X509Certificate", namespaces=ns))
    publica = x509.load_der_x509_certificate(cert_der).public_key()
    valor = base64.b64decode(sig.findtext("ds:SignatureValue", namespaces=ns))
    try:
        publica.verify(valor, _c14n(sig.find("ds:SignedInfo", ns)), padding.PKCS1v15(),
                       hashes.SHA1())
    except Exception:
        return False
    return True

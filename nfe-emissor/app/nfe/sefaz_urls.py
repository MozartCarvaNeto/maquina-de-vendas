"""URLs dos web services de NF-e 4.00 (modelo 55).

STATUS DA VERIFICAÇÃO (consulta feita em 22/11/2026):
  * SP ...... conferido na página oficial da SEFAZ-SP.
  * Demais ... montados a partir do padrão conhecido de cada autorizador e NÃO conferidos
               em fonte oficial. Antes de ir para produção, confirme a sua UF no Portal
               Nacional da NF-e (nfe.fazenda.gov.br -> Serviços -> Web Services) e use o botão
               "Testar conexão com a SEFAZ" na tela Configurações.
Qualquer URL pode ser corrigida/adicionada sem mexer no código, na tela
Configurações > Endereços da SEFAZ (ou, uso avançado, no arquivo data/sefaz_urls.json).
"""
import json
from pathlib import Path

SERVICOS = ("NFeAutorizacao4", "NFeRetAutorizacao4", "NFeConsultaProtocolo4",
            "NFeStatusServico4", "NFeRecepcaoEvento4")

VERIFICADOS = {"SP"}


def _asmx(base: str, nomes: dict[str, str]) -> dict[str, str]:
    return {s: f"{base}{caminho}" for s, caminho in nomes.items()}


_SP_PATHS = {
    "NFeAutorizacao4": "nfeautorizacao4.asmx",
    "NFeRetAutorizacao4": "nferetautorizacao4.asmx",
    "NFeConsultaProtocolo4": "nfeconsultaprotocolo4.asmx",
    "NFeStatusServico4": "nfestatusservico4.asmx",
    "NFeRecepcaoEvento4": "nferecepcaoevento4.asmx",
}
_SVRS_PATHS = {
    "NFeAutorizacao4": "NfeAutorizacao/NFeAutorizacao4.asmx",
    "NFeRetAutorizacao4": "NfeRetAutorizacao/NFeRetAutorizacao4.asmx",
    "NFeConsultaProtocolo4": "NfeConsulta/NfeConsulta4.asmx",
    "NFeStatusServico4": "NfeStatusServico/NfeStatusServico4.asmx",
    "NFeRecepcaoEvento4": "recepcaoevento/recepcaoevento4.asmx",
}
_SVAN_PATHS = {s: f"{s}/{s}.asmx" for s in SERVICOS}


def _java_style(base: str) -> dict[str, str]:
    return {s: f"{base}{s}" for s in SERVICOS}


# ambiente "1" = produção, "2" = homologação
AUTORIZADORES: dict[str, dict[str, dict[str, str]]] = {
    "SP": {
        "1": _asmx("https://nfe.fazenda.sp.gov.br/ws/", _SP_PATHS),
        "2": _asmx("https://homologacao.nfe.fazenda.sp.gov.br/ws/", _SP_PATHS),
    },
    "SVRS": {
        "1": _asmx("https://nfe.svrs.rs.gov.br/ws/", _SVRS_PATHS),
        "2": _asmx("https://nfe-homologacao.svrs.rs.gov.br/ws/", _SVRS_PATHS),
    },
    "RS": {
        "1": _asmx("https://nfe.sefazrs.rs.gov.br/ws/", _SVRS_PATHS),
        "2": _asmx("https://nfe-homologacao.sefazrs.rs.gov.br/ws/", _SVRS_PATHS),
    },
    "SVAN": {
        "1": _asmx("https://www.sefazvirtual.fazenda.gov.br/", _SVAN_PATHS),
        "2": _asmx("https://hom.sefazvirtual.fazenda.gov.br/", _SVAN_PATHS),
    },
    "MG": {
        "1": _java_style("https://nfe.fazenda.mg.gov.br/nfe2/services/"),
        "2": _java_style("https://hnfe.fazenda.mg.gov.br/nfe2/services/"),
    },
    "PR": {
        "1": _java_style("https://nfe.sefa.pr.gov.br/nfe/"),
        "2": _java_style("https://homologacao.nfe.sefa.pr.gov.br/nfe/"),
    },
    "GO": {
        "1": _java_style("https://nfe.sefaz.go.gov.br/nfe/services/"),
        "2": _java_style("https://homolog.sefaz.go.gov.br/nfe/services/"),
    },
    "PE": {
        "1": _java_style("https://nfe.sefaz.pe.gov.br/nfe-service/services/"),
        "2": _java_style("https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/"),
    },
    "BA": {
        "1": _asmx("https://nfe.sefaz.ba.gov.br/webservices/",
                   {s: f"{s}/{s}.asmx" for s in SERVICOS}),
        "2": _asmx("https://hnfe.sefaz.ba.gov.br/webservices/",
                   {s: f"{s}/{s}.asmx" for s in SERVICOS}),
    },
}

# Autorizador de cada UF. UFs com autorizador próprio ainda sem URL cadastrada aqui
# (AM, CE, MS, MT) exigem o arquivo data/sefaz_urls.json.
UF_AUTORIZADOR = {
    "AM": "AM", "BA": "BA", "CE": "CE", "GO": "GO", "MG": "MG", "MS": "MS", "MT": "MT",
    "PE": "PE", "PR": "PR", "RS": "RS", "SP": "SP", "MA": "SVAN",
}


def autorizador_da_uf(uf: str) -> str:
    return UF_AUTORIZADOR.get(uf, "SVRS")


def padrao(autorizador: str, ambiente: str) -> dict[str, str]:
    """Endereços que vêm de fábrica (sem alterações do usuário)."""
    return dict(AUTORIZADORES.get(autorizador, {}).get(str(ambiente), {}))


def _tabela(override) -> dict:
    """Mescla os endereços de fábrica com as alterações.

    `override` pode ser um dict {autorizador: {ambiente: {servico: url}}} (alterações feitas no
    painel) ou o caminho de um JSON no mesmo formato (uso avançado).
    """
    tabela = {k: {a: dict(s) for a, s in v.items()} for k, v in AUTORIZADORES.items()}
    if isinstance(override, (str, Path)):
        caminho = Path(override)
        override = json.loads(caminho.read_text(encoding="utf-8")) if caminho.exists() else {}
    for nome, ambientes in (override or {}).items():
        for amb, servicos in ambientes.items():
            tabela.setdefault(nome, {}).setdefault(str(amb), {}).update(servicos)
    return tabela


def listar_urls(autorizador: str, ambiente: str, override=None) -> dict[str, str]:
    """URL efetiva de cada serviço ('' quando não cadastrada)."""
    efetivas = _tabela(override).get(autorizador, {}).get(str(ambiente), {})
    return {s: efetivas.get(s, "") for s in SERVICOS}


def obter_url(autorizador: str, ambiente: str, servico: str, override=None) -> str:
    try:
        return _tabela(override)[autorizador][str(ambiente)][servico]
    except KeyError as exc:
        raise KeyError(
            f"O endereço do serviço {servico} do autorizador {autorizador} (ambiente {ambiente}) "
            f"não está cadastrado. Preencha em Configurações > Endereços da SEFAZ."
        ) from exc

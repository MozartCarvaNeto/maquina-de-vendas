"""Tabelas de códigos usadas na NF-e."""

UF_CODIGO = {
    "AC": "12", "AL": "27", "AP": "16", "AM": "13", "BA": "29", "CE": "23", "DF": "53",
    "ES": "32", "GO": "52", "MA": "21", "MT": "51", "MS": "50", "MG": "31", "PA": "15",
    "PB": "25", "PR": "41", "PE": "26", "PI": "22", "RJ": "33", "RN": "24", "RS": "43",
    "RO": "11", "RR": "14", "SC": "42", "SP": "35", "SE": "28", "TO": "17",
}
UFS = sorted(UF_CODIGO)

CRT = [
    ("1", "1 - Simples Nacional"),
    ("2", "2 - Simples Nacional (excesso de sublimite)"),
    ("3", "3 - Regime Normal (Lucro Presumido/Real)"),
]

# CSOSN (Simples) e CST (regime normal) suportados por este emissor
ICMS_SIMPLES = [
    ("101", "101 - Tributada com permissão de crédito"),
    ("102", "102 - Tributada sem permissão de crédito"),
    ("103", "103 - Isenção do ICMS para faixa de receita bruta"),
    ("300", "300 - Imune"),
    ("400", "400 - Não tributada pelo Simples Nacional"),
]
ICMS_NORMAL = [
    ("00", "00 - Tributada integralmente"),
    ("40", "40 - Isenta"),
    ("41", "41 - Não tributada"),
    ("50", "50 - Suspensão"),
]
ICMS_TODOS = ICMS_SIMPLES + ICMS_NORMAL

ORIGEM = [
    ("0", "0 - Nacional"),
    ("1", "1 - Estrangeira (importação direta)"),
    ("2", "2 - Estrangeira (adquirida no mercado interno)"),
    ("3", "3 - Nacional, importação 40% a 70%"),
    ("4", "4 - Nacional, processos produtivos básicos"),
    ("5", "5 - Nacional, importação até 40%"),
    ("6", "6 - Estrangeira (importação direta, sem similar)"),
    ("7", "7 - Estrangeira (mercado interno, sem similar)"),
    ("8", "8 - Nacional, importação superior a 70%"),
]

PIS_COFINS_CST = [
    ("49", "49 - Outras operações de saída (padrão Simples Nacional)"),
    ("01", "01 - Tributável (alíquota básica)"),
    ("02", "02 - Tributável (alíquota diferenciada)"),
    ("04", "04 - Monofásica (alíquota zero)"),
    ("06", "06 - Alíquota zero"),
    ("07", "07 - Isenta"),
    ("08", "08 - Sem incidência"),
    ("09", "09 - Com suspensão"),
    ("99", "99 - Outras operações"),
]

IND_IE_DEST = [
    ("9", "9 - Não contribuinte (pessoa física / sem IE)"),
    ("1", "1 - Contribuinte do ICMS (com IE)"),
    ("2", "2 - Contribuinte isento de inscrição"),
]

IND_PRES = [
    ("2", "2 - Operação não presencial, pela Internet"),
    ("3", "3 - Operação não presencial, teleatendimento"),
    ("4", "4 - NFC-e com entrega a domicílio"),
    ("9", "9 - Operação não presencial, outros"),
    ("1", "1 - Operação presencial"),
    ("0", "0 - Não se aplica"),
]

MOD_FRETE = [
    ("0", "0 - Por conta do remetente (CIF)"),
    ("1", "1 - Por conta do destinatário (FOB)"),
    ("2", "2 - Por conta de terceiros"),
    ("3", "3 - Transporte próprio, remetente"),
    ("4", "4 - Transporte próprio, destinatário"),
    ("9", "9 - Sem ocorrência de transporte"),
]

FORMA_PAGTO = [
    ("17", "17 - PIX"),
    ("03", "03 - Cartão de crédito"),
    ("04", "04 - Cartão de débito"),
    ("15", "15 - Boleto bancário"),
    ("01", "01 - Dinheiro"),
    ("99", "99 - Outros"),
    ("90", "90 - Sem pagamento"),
]

NOTA_STATUS = {
    "rascunho": "Rascunho",
    "autorizada": "Autorizada",
    "rejeitada": "Rejeitada",
    "denegada": "Denegada",
    "cancelada": "Cancelada",
    "pendente": "Pendente (consultar)",
}

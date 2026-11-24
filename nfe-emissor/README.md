# Emissor de NF-e próprio (modelo 55)

Sistema web para emitir NF-e direto na SEFAZ com o **seu certificado digital A1**, sem Tiny/Olist:
cadastro da empresa, produtos (NCM, CFOP, CSOSN/CST...), clientes, notas, assinatura digital,
envio, DANFE em PDF, consulta, cancelamento e exportação mensal de XMLs para o contador.
Dentro do Turbo Prospect ele roda como serviço próprio (`bash deploy/instalar-nfe.sh`) e usa o mesmo login do Turbo; cada conta tem pasta, banco, certificado e numeração separados.

> ## Leia antes de usar em produção
> 1. **Nunca foi testado contra a SEFAZ real.** Os testes automatizados usam respostas simuladas e
>    um servidor local com TLS de certificado de cliente. Eles provam que o XML é gerado, assinado
>    e interpretado de forma coerente, **não que a SEFAZ vai aprovar**. Rode **muitas** notas em
>    **homologação** e corrija o que for rejeitado antes de ligar a produção.
> 2. **O leiaute da NF-e muda.** Em 22/11/2026 a reforma tributária (IBS/CBS) estava em transição:
>    para o Simples Nacional, os novos campos entram em produção em **14/12/2026** (data adiada
>    de 16/11) e o schema oficial ainda não estava publicado. Este projeto gera o leiaute 4.00 base.
>    Depois dessa data a SEFAZ pode exigir grupos novos: acompanhe as Notas Técnicas no Portal
>    Nacional da NF-e e confirme com seu contador. Todo o XML está em `app/nfe/xml_builder.py`.
> 3. **Fale com seu contador** sobre regime, CFOP, CSOSN/CST e o que escrever em cada produto. Este
>    sistema só transmite o que você cadastrar: ele não decide a tributação por você.
> 4. Você precisa estar **credenciado como emissor de NF-e** na SEFAZ da sua UF (se já usa o Tiny, já está).

## O que faz

- Aba **Configurações**: dados da empresa, regime tributário (Simples Nacional ou normal), ambiente, série/numeração,
  certificado digital e endereços da SEFAZ, tudo editável pelo painel. Ao trocar o regime, o sistema avisa quais produtos precisam de ajuste.
- Certificado **A1** (.pfx/.p12): enviado na aba *Configurações*, validado (senha, validade, CNPJ da
  mesma raiz da empresa) e guardado com a senha criptografada.
- Produtos com origem, NCM, CEST, GTIN, CFOP, CSOSN/CST, PIS/COFINS; clientes PF/PJ com busca de CEP (preenche o código IBGE).
- Nota: itens, frete, desconto e outras despesas (rateados por item), pagamento (PIX, cartão, boleto...),
  intermediador (marketplace) e informações adicionais.
- Chave de acesso, XML 4.00, assinatura XMLDSig (RSA-SHA1, exigido pela SEFAZ), envio SOAP 1.2 com
  TLS mútuo, recibo/protocolo, `nfeProc` autorizado salvo no banco **e** em disco (`data/xmls/AAAA-MM/`).
- Consulta de situação por chave; nota que ficou sem resposta vira **Pendente** e exige consulta antes de reenviar (evita duplicidade).
- Cancelamento (evento 110111), DANFE em PDF (marca d'água em homologação/sem protocolo/cancelada; **logotipo da empresa** enviado em Configurações e impresso no topo),
  ZIP mensal dos XMLs.
- Aba **Integrações**: botão **Importar pedidos** para **Nuvemshop, Shopify, WooCommerce e Mercado Livre**. Cada pedido pago
  vira um **rascunho de nota** (e um cliente, se novo) para você revisar, editar e emitir. Veja a seção "Integrações com lojas".
- Sem login próprio: o Turbo Prospect autentica e envia a conta por cabeçalhos assinados (HMAC). Proteção CSRF e cabeçalhos de segurança mantidos.

## O que NÃO faz (ainda)

NFC-e (modelo 65), NFS-e (serviços), inutilização de numeração, carta de correção, devolução/NF
complementar, contingência (SVC), certificado **A3** (token/cartão não funciona online), IPI, ICMS-ST,
DIFAL (grupo `ICMSUFDest`, relevante para regime normal vendendo a consumidor final de outra UF),
CSOSN 500/900 e CST além de 00/40/41/50, grupos IBS/CBS, importação de produtos por planilha,
importação automática/agendada de pedidos (só sob demanda, pelo botão), importação por CSV. O Simples Nacional (CRT 1) é o foco: o regime normal
(CRT 3) funciona só no básico.

## Rodar no seu computador (teste)

Precisa de Python 3.10 ou mais novo.

```bash
cd nfe-emissor
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt pytest
python -m pytest tests            # testes automáticos
```

No servidor, use `bash deploy/instalar-nfe.sh` (na raiz do projeto). O emissor não abre sozinho no navegador:
ele só aceita chamadas assinadas pelo Turbo Prospect (rota `/nfe-app`).

Dados ficam em `DATA_DIR/contas/<id da conta>/` (banco SQLite, certificado, XMLs). No servidor: `/var/lib/nfe-emissor`.


## Primeiros passos no sistema (sempre em homologação!)

1. **Configurações**: preencha tudo (CNPJ, IE, endereço e regime tributário; o padrão é Simples Nacional e pode ser trocado quando quiser). Use *Buscar CEP* para o código IBGE.
   Deixe o ambiente em **Homologação**. Se você vem do Tiny, use outra **série** (ex.: 2) ou informe o último número emitido.
2. **Certificado**: envie o .pfx e a senha. Clique em **Testar conexão com a SEFAZ**: deve responder `107 - Serviço em Operação`.
3. **Produtos** e **Clientes**: cadastre um de cada.
4. **Notas > Nova nota**, salve o rascunho, clique em **Emitir NF-e**. Em homologação deve voltar `100 - Autorizado o uso da NF-e`.
5. Confira o **DANFE** e o **XML**. Repita com casos reais (frete, desconto, outro estado, PF e PJ).
6. Só então, em *Configurações*, troque para **Produção** (exige confirmação).

## Integrações com lojas (aba Integrações)

> **Nunca testadas contra lojas reais.** Os conectores foram escritos a partir da documentação pública de cada API e
> testados com respostas simuladas. Alguns detalhes não puderam ser conferidos (marcados abaixo): teste com UM pedido
> primeiro e me mostre/ajuste o que vier errado. Nada é emitido sozinho: tudo entra como **rascunho**.

Como funciona: em *Integrações*, salve as credenciais da plataforma, clique **Testar conexão** e depois **Importar pedidos**
(escolha quantos dias para trás). Só entram pedidos **pagos**. Pedidos já importados não são duplicados; se você
excluir o rascunho, o pedido pode ser importado de novo. Credenciais ficam cifradas no banco (como a senha do certificado).

Regras de importação:
- **Produto**: ligado pelo **SKU da loja = Código do produto** cadastrado aqui (ignora maiúsculas). Os dados fiscais
  (NCM, CFOP, CSOSN...) vêm do cadastro. SKU desconhecido cria um produto **sem NCM**: complete em *Produtos* e depois
  abra o rascunho e salve de novo para ele puxar o NCM.
- **Cliente**: o **CPF/CNPJ é obrigatório** na NF-e. Pedido sem documento válido **não é importado** (aparece o aviso).
  O código IBGE do município vem do CEP (ViaCEP). Cliente com o mesmo documento é reaproveitado.
- **Valores**: preço unitário, frete e desconto vêm do pedido. Se o total da nota diferir do total do pedido
  (taxas, juros de parcelamento...), aparece um aviso: confira antes de emitir.
- **Pagamento**: PIX, cartão, boleto são reconhecidos pelo nome do meio de pagamento; o resto vira "99 - Outros".
- **Mercado Livre é marketplace**: pode ser necessário informar o **intermediador** (CNPJ + identificador) na nota. Fale com o contador.

| Plataforma | Credenciais | Observações |
|---|---|---|
| Nuvemshop | ID da loja + token de acesso do app | CPF/CNPJ vem de `contact_identification`. Cabeçalho de autenticação: não consegui confirmar na documentação se é `Authentication: bearer` ou `Authorization`; o sistema envia os dois. |
| Shopify | `loja.myshopify.com` + token Admin API (app personalizado, escopo `read_orders`) | Usa a API GraphQL (a REST é legada). Para ver nome/endereço do cliente o app precisa de acesso a **dados protegidos de clientes**. A Shopify não tem campo de CPF: o sistema procura na nota do pedido, nos atributos do pedido e no campo "empresa" do endereço. Se sua loja coleta CPF de outro jeito, é preciso ajustar `app/integracoes/shopify.py`. |
| WooCommerce | URL da loja (https) + consumer key/secret (WooCommerce > Configurações > Avançado > API REST, permissão leitura) | CPF/CNPJ, número e bairro dependem de plugin brasileiro (ex.: Brazilian Market): campos `billing_cpf`, `billing_cnpj`, `billing_number`, `billing_neighborhood`. Sem esses campos os pedidos serão ignorados. Importa pedidos "processando" e "concluído". |
| Mercado Livre | App ID e Secret de um aplicativo seu em developers.mercadolivre.com.br | Autorização por OAuth: cadastre no app a URL de redirecionamento exibida na tela e clique em *Autorizar*. Os endereços de OAuth e o formato dos dados do comprador vieram em parte da documentação e em parte de conhecimento prévio; o Mercado Livre às vezes oculta dados pessoais do comprador. |

## Endereços da SEFAZ

Ficam em **Configurações > Endereços da SEFAZ**, por ambiente (homologação/produção) e por serviço. Apenas **SP** veio
conferido em fonte oficial; os demais seguem o padrão conhecido de cada autorizador e **precisam ser confirmados** no
Portal Nacional da NF-e (nfe.fazenda.gov.br → Serviços → Web Services). AM, CE, MS e MT vêm vazios: preencha ali.
Campo vazio volta ao padrão. Por segurança só são aceitos endereços `https` de sites `.gov.br` (o certificado digital é
apresentado a esses endereços). Depois de alterar, use **Testar conexão com a SEFAZ**: é a forma mais rápida de saber se
o endereço e o certificado estão certos. Uso avançado: o arquivo `data/sefaz_urls.json` (mesmo formato
`{"UF": {"2": {"NFeAutorizacao4": "https://..."}}}`) também é lido.

## Validação local com os XSD oficiais (recomendado)

Baixe no Portal Nacional da NF-e o pacote de schemas vigente ("Pacote de Liberação" mais recente) e
extraia os `.xsd` em `data/schemas/`. Se existir `enviNFe_v4.00.xsd`, cada nota é validada antes do
envio e o erro aparece com a linha, em vez de uma rejeição 225 da SEFAZ.

## Erro de TLS ao falar com a SEFAZ

Se aparecer "certificado desconhecido", o servidor não confia na cadeia ICP-Brasil. Baixe a cadeia de
certificados no Portal da NF-e, salve em formato PEM e aponte `SEFAZ_CA_BUNDLE=/data/cadeia.pem` no `.env`.
O sistema nunca desliga a verificação de certificado.

## Segurança e guarda de dados

- O servidor guarda o seu certificado e a senha (criptografada com `SECRET_KEY`). Quem controla o
  servidor pode emitir notas em seu nome: use HTTPS, senha longa, e mantenha o servidor atualizado.
- **Faça backup** de `data/` (ou do volume Docker): XMLs autorizados devem ser guardados por **5 anos**.
  Guarde também a `SECRET_KEY`.
- Não publique `.env`, `data/` nem arquivos `.pfx`.

## Estrutura (integrações em app/integracoes/: um módulo por plataforma + importador.py)


```
app/
  views.py          rotas web          servico.py   emitir/consultar/cancelar (banco + SEFAZ)
  nfe/xml_builder.py  XML 4.00         nfe/assinatura.py  XMLDSig
  nfe/sefaz.py        SOAP/TLS mútuo   nfe/sefaz_urls.py  endereços
  nfe/danfe.py        PDF              nfe/certificado.py A1 (.pfx)
  templates/ static/  telas
deploy/Caddyfile  Dockerfile  docker-compose.yml  tests/
```

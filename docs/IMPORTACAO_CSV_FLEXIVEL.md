# Importação flexível de clientes e produtos (CSV / Excel)

## O que mudou
- **Nada é descartado.** Linha com dado faltando ou inválido (NCM, CEP, CPF/CNPJ, IE, e-mail, CST...) é
  salva no cadastro como **incompleta**, com a lista do que falta. Você completa depois em
  *Produtos* / *Clientes* (botão **completar**).
- Só **não** é salva a linha sem como identificar: produto sem código *e* sem descrição; cliente sem CPF/CNPJ *e* sem nome.
- Produto sem código ganha um código automático `IMP-XXXXXXXX` (o mesmo texto gera sempre o mesmo código, então
  reimportar não duplica). Cliente sem CPF/CNPJ é reconhecido pelo nome ao reimportar.
- **Cadastro que já existia não é estragado:** valor inválido na planilha é ignorado (mantém o antigo) e aparece em
  "atualizados com ressalva". Célula vazia continua nunca apagando nada.
- Importar de novo uma planilha corrigida **completa** o cadastro incompleto (mesmo no modo "pular").
- Leitor mais tolerante: cabeçalho pode estar até a 15ª linha (títulos/linhas em branco antes), mais nomes de coluna
  aceitos, `R$ 12,50`, `18%`, unidade por extenso (Unidade→UN, Peça→PC...), origem "Nacional/Importado".
  Basta existir **código ou descrição** (produto) / **CPF/CNPJ ou nome** (cliente) no cabeçalho.
- Telas: aviso e filtro "Ver só os incompletos", selo **incompleto** na lista, mensagem com o que falta na tela de
  edição e botão **Salvar incompleto** nos formulários manuais.
- **Emissão protegida:** nota com cliente/produto incompleto não é emitida; a mensagem diz o que falta. Rascunhos podem ser criados normalmente.
- Pedidos importados de Nuvemshop/Shopify/WooCommerce/Mercado Livre também marcam produto sem NCM e cliente sem IBGE como incompletos.

## Como aplicar
1. Copie a pasta `nfe-emissor` do zip sobre a do servidor (o banco migra sozinho: colunas `pendente` e `pendencias`;
   produtos antigos sem NCM válido passam a aparecer como incompletos).
2. `sudo systemctl restart nfe-emissor`
3. No navegador, Ctrl+F5.

## Testes
`cd nfe-emissor && python3 -m unittest discover -s tests` → 66 testes passando.

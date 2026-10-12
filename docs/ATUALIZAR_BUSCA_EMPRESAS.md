# Turbo Prospect — Busca de Empresas (prospecção B2B)

## O que é
Nova tela **🔍 Buscar Empresas** (menu lateral, módulo "Contatos"). O usuário digita o **ramo** (ex.: clínica odontológica) e a **cidade ou estado** (ex.: Campinas SP). O sistema varre a fonte escolhida, mostra empresas com **nome, telefone, e-mail (se achar), site e endereço** e salva as marcadas numa **lista com o nome que o usuário escolher**. A lista fica disponível em Listas, Disparos, Ligações e Campanhas.

## Fontes
| Fonte | Custo | O que traz |
|---|---|---|
| Google Maps (Places API) | Chave do próprio cliente. O Google dá crédito mensal grátis; acima disso cobra no cartão do cliente | Nome, telefone, site, endereço — o mais completo |
| OpenStreetMap | Grátis, sem chave | Nome, endereço; telefone/e-mail só onde voluntários cadastraram (cobertura menor) |
| Botão "Procurar e-mails nos sites" | Grátis | Lê a página inicial e de contato do site da empresa e pega e-mails públicos |

Por que o cliente usa a própria chave do Google: o Google não permite varrer o Maps por fora da API oficial, e assim o custo não recai sobre você.

## Como o cliente configura o Google (uma vez)
Configurações › Busca de empresas. Passos exibidos na própria tela: console.cloud.google.com → criar projeto → ativar **Places API (New)** → Credenciais → Criar chave de API → colar no sistema. (Recomenda-se restringir a chave à Places API.)

## Regras e proteções
- Remove repetidos e marca "já na sua base" (compara os últimos 8 dígitos do telefone).
- Quem já existe nos Contatos não é duplicado: só entra na lista nova.
- Telefones padronizados em +55; celular recebe 💬 (provável WhatsApp).
- Contatos criados com origem **"Busca de empresas B2B"** e etiquetas `b2b`, `busca-empresas` e o ramo.
- Limite de 40 buscas por hora por conta (evita custo por clique repetido); máximo 60 empresas por busca.
- O robô de WhatsApp trata quem responde como empresa prospectada (apresenta-se e respeita pedido de saída).
- Aviso de LGPD na tela: identifique-se e ofereça a saída da lista.

## Como instalar
Extraia o zip por cima do projeto, Commit e Push no GitHub Desktop, e no servidor: `bash deploy/atualizar-servidor.sh` (sem `--banco`, não há colunas novas, **mas** o campo `source` do lead veio da atualização "Campanhas": instale-a antes, se ainda não o fez).

## Teste
1. Buscar Empresas › "dentista" em "Campinas SP" › fonte OpenStreetMap › Buscar.
2. Marque as empresas, dê um nome à lista e salve. Abra Listas e confira.
3. Com a chave do Google cadastrada, repita escolhendo Google Maps.

## Observações honestas
- Telefone de empresa no Google costuma ser fixo; fixos servem para ligação, não para WhatsApp.
- E-mail só aparece quando o site publica; muitos sites usam só formulário.
- Sites que carregam tudo por JavaScript podem não revelar e-mail.
- Este recurso não faz coleta de redes sociais nem de dados pessoais de sócios.

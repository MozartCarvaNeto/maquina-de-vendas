# Atualização: busca rápida de cliente/produto na nota (corrige a lentidão)

## O que mudou
- A tela **Nova nota fiscal** deixou de carregar todos os clientes e produtos dentro da página.
  Antes: com 5.000 clientes + 5.000 produtos a página tinha ~1,5 MB e 15 mil opções, e **cada item
  adicionado somava mais 5.000 opções** no navegador (por isso travava e demorava para abrir).
  Agora a página tem ~10 KB e a busca consulta o servidor enquanto você digita (até 50 resultados por vez).
- Você pode **digitar ou colar** nome, CPF/CNPJ (com ou sem pontuação), código, descrição ou NCM.
  Não diferencia maiúsculas/minúsculas nem acentos. Colar o texto completo `Nome (CPF)` também funciona.
- Setas ↑ ↓ e Enter escolhem; Esc fecha; se o texto digitado não for escolhido na lista, o formulário avisa.
- Arquivos CSS/JS agora ficam em cache no navegador (e atualizam sozinhos quando mudarem).

## Como aplicar (servidor)
Só o emissor de NF-e (Python) mudou. **Não precisa recompilar o frontend nem mexer no banco.**

1. Copie o conteúdo da pasta `nfe-emissor` deste pacote por cima da `nfe-emissor` do servidor.
   (ou, se você usa GitHub: envie as mudanças e rode `git pull` no servidor.)
2. Reinicie o emissor — **este passo é obrigatório**, senão o servidor continua com o código antigo:
   ```
   sudo systemctl restart nfe-emissor
   ```
3. No navegador, abra Notas Fiscais e aperte **Ctrl+F5** uma vez.

Teste rápido: Notas Fiscais → Notas → Nova nota → clique em Cliente e digite parte do nome.

## Testes automáticos (opcional)
```
cd nfe-emissor && .venv/bin/python -m unittest discover -s tests
```

# Correção: "Falha na conexão segura (TLS) com a SEFAZ ... CERTIFICATE_VERIFY_FAILED"

## O que estava acontecendo
Seus dados da empresa e o certificado **foram salvos** (eles aparecem preenchidos na tela). O erro vermelho vinha do botão **"Testar conexão com a SEFAZ"**: os servidores da SEFAZ usam certificados da cadeia **ICP-Brasil**, que não vem instalada no Python nem no Windows. Sem ela, o programa se recusa a conectar (por segurança) e nenhuma nota poderia ser emitida.

## O que foi corrigido
- Novo módulo `app/nfe/tls.py`: baixa a cadeia oficial ICP-Brasil (ITI) sozinho na primeira falha, guarda na pasta `data/` e passa a usá-la.
- Em **Configurações › Certificado digital** há agora o bloco "Certificados de segurança da SEFAZ": botão **Baixar cadeia ICP-Brasil automaticamente** e campo para enviar o arquivo `ACcompactado.zip` manualmente (caso o download automático seja bloqueado na sua rede).
- A conexão agora aceita os certificados ICP-Brasil também no Python 3.13 (que é mais rígido que os anteriores).
- Mensagem de erro mais clara e limite de upload aumentado para 10 MB.
- Testes: 37 (avulso) / 40 (integrado ao Turbo), incluindo um servidor HTTPS simulado com certificado de cliente.

## Como atualizar (versão avulsa, a que você roda em localhost:5000)
1. Pare o programa (Ctrl+C no terminal).
2. Extraia `nfe-emissor-corrigido.zip` **por cima** da pasta do emissor (a pasta `data/` com seus dados NÃO está no zip: nada se perde).
3. No terminal, dentro da pasta: `pip install -r requirements.txt` e depois `python run_local.py`.
4. Abra Configurações › role até **Certificado digital** › clique em **Baixar cadeia ICP-Brasil automaticamente** › depois **Testar conexão com a SEFAZ**.
   - Esperado: "SEFAZ (SP) respondeu: 107 - Serviço em Operação".
5. Se o download automático falhar: baixe `ACcompactado.zip` em gov.br/iti (Repositório › Cadeias de certificados ICP-Brasil) e envie no campo do mesmo bloco.

## Versão dentro do Turbo Prospect
O zip `maquina-de-vendas-completo.zip` já traz a mesma correção. No servidor: `bash deploy/atualizar-servidor.sh`. Depois, na aba Notas Fiscais › Configurações, use o mesmo botão (a cadeia é instalada uma vez para todas as contas).

## Cuidados
- Não consegui testar com a SEFAZ real nem baixar o pacote do ITI daqui (rede bloqueada). A lógica foi validada com um servidor TLS simulado. O endereço de download é o oficial do ITI; se ele mudar, use o envio manual do arquivo.
- Você está em **PRODUÇÃO**: notas emitidas têm valor fiscal. Faça primeiro várias notas em **Homologação** (Configurações › Ambiente) e só depois ligue produção.
- Se "Testar conexão" passar a dar outro erro (ex.: certificado de cliente recusado, 'rejeição'), me envie a mensagem nova.

@echo off
title Maquina de Vendas
color 0B
cd /d "%~dp0"

echo ============================================
echo    MAQUINA DE VENDAS - Iniciando sistema
echo ============================================
echo.

REM ---------- BACKEND ----------
cd /d "%~dp0backend"

if not exist node_modules (
  echo [1/3] Instalando dependencias do backend pela primeira vez...
  echo       Isso pode demorar alguns minutos ^(baixa o navegador do WhatsApp^).
  call npm install
)

REM ---------- FRONTEND (so compila se ainda nao tiver sido compilado) ----------
if not exist "%~dp0frontend\dist" (
  echo [2/3] Compilando o frontend pela primeira vez...
  cd /d "%~dp0frontend"
  if not exist node_modules (
    call npm install
  )
  call npm run build
  cd /d "%~dp0backend"
) else (
  echo [2/3] Frontend ja compilado, pulando esta etapa.
)

REM ---------- Gerar cliente do banco (rapido, seguro rodar sempre) ----------
call npx prisma generate >nul 2>&1

echo [3/3] Iniciando o servidor...
echo.
start "Maquina de Vendas - Servidor" cmd /k "npm start"

timeout /t 6 /nobreak >nul
start "" "http://localhost:3333"

echo.
echo O sistema esta rodando em http://localhost:3333
echo Uma janela preta ficou aberta com o nome "Maquina de Vendas - Servidor"
echo ^-- NAO FECHE essa janela enquanto estiver usando o sistema.
echo Para desligar, feche aquela janela ou pressione Ctrl+C nela.
echo.
pause
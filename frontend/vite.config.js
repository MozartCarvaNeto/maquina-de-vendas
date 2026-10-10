// frontend/vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 'autoUpdate': quando você sobe uma versão nova do site, o app já
      // troca sozinho o "miolo" (service worker) na próxima vez que abrir,
      // sem precisar desinstalar/reinstalar nada.
      registerType: 'autoUpdate',
      injectRegister: 'auto',

      // Arquivos estáticos que devem ir para o cache do app (funciona
      // offline para a casca do site; os dados de verdade continuam vindo
      // da API normalmente, com internet).
      includeAssets: ['favicon.png', 'favicon-16.png', 'favicon-32.png', 'apple-touch-icon.png'],

      manifest: {
        name: 'Turbo Prospect — Máquina de Vendas',
        short_name: 'Turbo Prospect',
        description: 'Prospecção, disparos, CRM e ligações — tudo em um só lugar.',
        lang: 'pt-BR',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        // Cor da barra do navegador/topo do app quando instalado.
        theme_color: '#031b33',
        // Cor de fundo mostrada por um instante enquanto o app carrega.
        background_color: '#031b33',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
          // "maskable": versão com respiro nas bordas, pro Android poder
          // recortar em círculo, quadrado arredondado, etc. sem cortar o símbolo.
          { src: '/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },

      workbox: {
        // Garante que uma pessoa que já tinha o app instalado, ao voltar
        // sem internet por um instante, ainda veja a casca do app (login,
        // menu) em vez de uma tela de erro do navegador. As chamadas pra
        // /api continuam exigindo internet — isso aqui não deixa o sistema
        // funcionar 100% offline, só evita a tela branca.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/uploads\//],
        globPatterns: ['**/*.{js,css,html,png,svg,ico}']
      },

      devOptions: {
        // Permite testar o "Instalar app" já no `npm run dev`, sem precisar
        // gerar build de produção só para experimentar.
        enabled: true
      }
    })
  ],
  server: {
    port: 5173
  }
});
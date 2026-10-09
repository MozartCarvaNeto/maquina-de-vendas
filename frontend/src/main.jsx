// frontend/src/main.jsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import PwaManager from './pwa/PwaManager';
import './index.css';
import './responsive.css'; // ajustes para celular (por último, para ter prioridade)

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
      <PwaManager />
    </BrowserRouter>
  </React.StrictMode>
);
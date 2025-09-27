import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App'; // ✅ path from src
import './index.css';    // ✅ load Tailwind and custom styles
import "./styles/tokens.css";

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

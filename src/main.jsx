import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App'; // ✅ path from src
import './index.css';    // ✅ load Tailwind and custom styles
import "./styles/tokens.css";
import "./styles/shepherd-tabarnam.css";

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if ("serviceWorker" in navigator && (import.meta.env.PROD || window.location.hostname === "localhost")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch((error) => {
      console.warn("Service worker registration failed:", error);
    });
  });
}

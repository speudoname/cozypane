import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './styles/global.css';

// Apply persisted theme on load
try {
  const theme = localStorage.getItem('cozyPane:theme');
  if (theme) document.documentElement.setAttribute('data-theme', theme);
} catch {}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

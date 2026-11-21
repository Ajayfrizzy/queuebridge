import './zodConfig.js';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import './tokens.css';
import './styles.css';
import { applyStoredPrefs } from './lib/a11yPrefs.js';

// Apply the person's display preferences BEFORE the first render: no flash of the wrong theme
applyStoredPrefs();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found in DOM');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import './styles.css';

function resetInitialScrollPosition() {
  window.requestAnimationFrame(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    document.scrollingElement?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  });
}

if ('scrollRestoration' in window.history) {
  window.history.scrollRestoration = 'manual';
}

resetInitialScrollPosition();
window.addEventListener('pageshow', resetInitialScrollPosition, { once: true });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Ignore registration failures in local preview environments.
    });
  });
}

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>
);

import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { HttpError } from './lib/utils';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Diagnostic tool over a live pipeline - data going stale silently
      // is worse than an extra request, and socket events already drive
      // targeted invalidation on top of this.
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      // A 4xx (deleted job, bad id) won't succeed on retry - fail fast
      // and let the UI show a retry button instead of burning 3 rounds
      // of backoff first. Anything else gets exactly one retry.
      retry: (failureCount, error) => {
        if (error instanceof HttpError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 1;
      },
      retryDelay: 600,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
);

import { BrowserRouter, Routes, Route, Navigate } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import TreePage from './routes/Tree'
import TimelinePage from './routes/Timeline'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000, // 30 seconds
      refetchOnWindowFocus: false,
    },
  },
})

/**
 * App Component
 *
 * Root component with Router and QueryClientProvider.
 * Routes:
 * - / → redirects to /timeline
 * - /tree → Tree view
 * - /timeline → Timeline view
 */
function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/timeline" replace />} />
          <Route path="/tree" element={<TreePage />} />
          <Route path="/timeline" element={<TimelinePage />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

export default App

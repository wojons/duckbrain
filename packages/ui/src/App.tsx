import { BrowserRouter, Routes, Route, Link } from 'react-router'
import { Home, GitBranch, Clock, Brain } from 'lucide-react'
import HomePage from './routes/Home'
import TreePage from './routes/Tree'
import TimelinePage from './routes/Timeline'

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--color-midnight)' }}>
      {/* Header */}
      <header className="glass-panel glass-panel-hover m-4 p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Brain className="w-8 h-8" style={{ color: 'var(--color-azure)' }} />
          <h1 className="text-xl font-semibold" style={{ color: 'var(--color-pristine)' }}>
            DuckBrain
          </h1>
          <span className="text-sm px-2 py-1 rounded glass-panel" style={{ color: 'var(--color-clinical)' }}>
            Memory Archive
          </span>
        </div>
        <nav className="flex items-center gap-2">
          <Link
            to="/"
            className="glass-button px-4 py-2 flex items-center gap-2 text-sm"
          >
            <Home className="w-4 h-4" />
            Home
          </Link>
          <Link
            to="/tree"
            className="glass-button px-4 py-2 flex items-center gap-2 text-sm"
          >
            <GitBranch className="w-4 h-4" />
            Tree
          </Link>
          <Link
            to="/timeline"
            className="glass-button px-4 py-2 flex items-center gap-2 text-sm"
          >
            <Clock className="w-4 h-4" />
            Timeline
          </Link>
        </nav>
      </header>

      {/* Main Content */}
      <main className="px-4 pb-4">
        <div className="glass-panel p-6 min-h-[calc(100vh-140px)]">
          {children}
        </div>
      </main>
    </div>
  )
}

function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/tree" element={<TreePage />} />
          <Route path="/timeline" element={<TimelinePage />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  )
}

export default App

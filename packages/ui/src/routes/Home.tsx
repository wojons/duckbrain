import { Activity, Database, GitCommit, Layers } from 'lucide-react'

export default function Home() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold mb-2" style={{ color: 'var(--color-pristine)' }}>
            Welcome to DuckBrain
          </h2>
          <p style={{ color: 'var(--color-clinical)' }}>
            Your distributed, event-sourced memory archive
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full status-dot-active" />
          <span className="text-sm" style={{ color: 'var(--color-success)' }}>Active</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={<Database className="w-5 h-5" />}
          label="Total Memories"
          value="—"
          color="var(--color-azure)"
        />
        <StatCard
          icon={<GitCommit className="w-5 h-5" />}
          label="Commits Today"
          value="—"
          color="var(--color-amber)"
        />
        <StatCard
          icon={<Layers className="w-5 h-5" />}
          label="Namespaces"
          value="—"
          color="var(--color-pristine)"
        />
        <StatCard
          icon={<Activity className="w-5 h-5" />}
          label="Query Rate"
          value="—"
          color="var(--color-success)"
        />
      </div>

      <div className="glass-panel p-6">
        <h3 className="text-lg font-medium mb-4" style={{ color: 'var(--color-pristine)' }}>
          Recent Activity
        </h3>
        <div className="space-y-3">
          <ActivityItem
            action="Memory added"
            domain="config"
            key="/system/status"
            time="Just now"
          />
          <ActivityItem
            action="Memory recalled"
            domain="message"
            key="/chat/session-1"
            time="2 min ago"
          />
          <ActivityItem
            action="Namespace switched"
            domain="system"
            key="default"
            time="5 min ago"
          />
        </div>
      </div>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode
  label: string
  value: string
  color: string
}) {
  return (
    <div className="glass-panel p-4 glass-panel-hover">
      <div className="flex items-center gap-3 mb-3">
        <div style={{ color }}>{icon}</div>
        <span className="text-sm" style={{ color: 'var(--color-clinical)' }}>{label}</span>
      </div>
      <div className="text-2xl font-semibold" style={{ color: 'var(--color-pristine)' }}>
        {value}
      </div>
    </div>
  )
}

function ActivityItem({
  action,
  domain,
  key,
  time,
}: {
  action: string
  domain: string
  key: string
  time: string
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b last:border-0" style={{ borderColor: 'var(--color-glass-border)' }}>
      <div className="flex items-center gap-3">
        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--color-azure)' }} />
        <div>
          <div className="text-sm" style={{ color: 'var(--color-pristine)' }}>{action}</div>
          <div className="text-xs font-mono" style={{ color: 'var(--color-clinical)' }}>
            {domain} → {key}
          </div>
        </div>
      </div>
      <span className="text-xs" style={{ color: 'var(--color-clinical)' }}>{time}</span>
    </div>
  )
}

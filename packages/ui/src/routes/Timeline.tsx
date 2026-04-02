import { GitCommit, User, MessageSquare, Settings, Brain, FolderOpen } from 'lucide-react'

export default function Timeline() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold mb-1" style={{ color: 'var(--color-pristine)' }}>
            Memory Timeline
          </h2>
          <p style={{ color: 'var(--color-clinical)' }}>
            Chronological view of memory changes
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select className="glass-input px-3 py-2 text-sm">
            <option>All Domains</option>
            <option>Chat</option>
            <option>Config</option>
            <option>Concepts</option>
          </select>
          <select className="glass-input px-3 py-2 text-sm">
            <option>Last 24 hours</option>
            <option>Last 7 days</option>
            <option>Last 30 days</option>
            <option>All time</option>
          </select>
        </div>
      </div>

      <div className="glass-panel p-6">
        <div className="space-y-6">
          <TimelineGroup date="Today">
            <TimelineEvent
              icon={<Settings className="w-4 h-4" />}
              domain="config"
              action="Memory added"
              key="/system/status"
              time="2:34 PM"
              author="system"
            />
            <TimelineEvent
              icon={<MessageSquare className="w-4 h-4" />}
              domain="message"
              action="Memory recalled"
              key="/chat/session-1"
              time="2:15 PM"
              author="user"
            />
            <TimelineEvent
              icon={<Brain className="w-4 h-4" />}
              domain="concept"
              action="Memory updated"
              key="/concepts/patterns"
              time="1:42 PM"
              author="ai"
            />
          </TimelineGroup>

          <TimelineGroup date="Yesterday">
            <TimelineEvent
              icon={<User className="w-4 h-4" />}
              domain="person"
              action="Memory added"
              key="/people/new-contact"
              time="8:30 PM"
              author="user"
            />
            <TimelineEvent
              icon={<FolderOpen className="w-4 h-4" />}
              domain="project"
              action="Memory tombstoned"
              key="/projects/old"
              time="4:12 PM"
              author="system"
            />
            <TimelineEvent
              icon={<GitCommit className="w-4 h-4" />}
              domain="system"
              action="Git squash"
              key="/system/maintenance"
              time="3:00 AM"
              author="system"
            />
          </TimelineGroup>

          <TimelineGroup date="March 30, 2026">
            <TimelineEvent
              icon={<MessageSquare className="w-4 h-4" />}
              domain="message"
              action="Memory added"
              key="/chat/session-archive"
              time="6:45 PM"
              author="user"
            />
            <TimelineEvent
              icon={<Settings className="w-4 h-4" />}
              domain="config"
              action="Memory updated"
              key="/config/preferences"
              time="2:20 PM"
              author="user"
            />
          </TimelineGroup>
        </div>
      </div>

      <div className="glass-panel p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full status-dot-active" />
              <span className="text-sm" style={{ color: 'var(--color-clinical)' }}>Add</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: 'var(--color-amber)' }} />
              <span className="text-sm" style={{ color: 'var(--color-clinical)' }}>Update</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: 'var(--color-error)' }} />
              <span className="text-sm" style={{ color: 'var(--color-clinical)' }}>Tombstone</span>
            </div>
          </div>
          
          <button className="glass-button px-4 py-2 text-sm">
            Load more...
          </button>
        </div>
      </div>
    </div>
  )
}

function TimelineGroup({ date, children }: { date: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <div className="flex-1 h-px" style={{ backgroundColor: 'var(--color-glass-border)' }} />
        <span className="text-sm font-medium px-3 py-1 glass-panel rounded" style={{ color: 'var(--color-pristine)' }}>
          {date}
        </span>
        <div className="flex-1 h-px" style={{ backgroundColor: 'var(--color-glass-border)' }} />
      </div>
      
      <div className="space-y-2">{children}</div>
    </div>
  )
}

interface TimelineEventProps {
  icon: React.ReactNode
  domain: string
  action: string
  key: string
  time: string
  author: string
}

function TimelineEvent({ icon, domain, action, key: keyPath, time, author }: TimelineEventProps) {
  const domainColors: Record<string, string> = {
    config: 'var(--color-azure)',
    message: 'var(--color-amber)',
    concept: 'var(--color-success)',
    person: 'var(--color-pristine)',
    project: 'var(--color-clinical)',
    system: 'var(--color-error)',
  }

  return (
    <div className="flex items-start gap-4 py-3 px-4 glass-panel-hover rounded-lg">
      <div
        className="w-10 h-10 rounded-lg flex items-center justify-center"
        style={{ backgroundColor: 'var(--color-glass)', color: domainColors[domain] || 'var(--color-pristine)' }}
      >
        {icon}
      </div>
      
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium" style={{ color: 'var(--color-pristine)' }}>{action}</span>
          <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: 'var(--color-glass)', color: domainColors[domain] || 'var(--color-pristine)' }}>
            {domain}
          </span>
        </div>
        
        <div className="text-sm font-mono truncate" style={{ color: 'var(--color-clinical)' }}>{keyPath}</div>
      </div>
      
      <div className="text-right">
        <div className="text-sm" style={{ color: 'var(--color-pristine)' }}>{time}</div>
        <div className="text-xs" style={{ color: 'var(--color-clinical)' }}>{author}</div>
      </div>
    </div>
  )
}

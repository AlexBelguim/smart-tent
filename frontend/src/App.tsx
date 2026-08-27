import { useState } from 'react'
import Dashboard from './pages/Dashboard'
import History from './pages/History'
import Planner from './pages/Planner'
import Settings from './pages/Settings'

const TABS = ['Dashboard', 'History', 'Planner', 'Settings'] as const
type Tab = (typeof TABS)[number]

export default function App() {
  const [tab, setTab] = useState<Tab>('Dashboard')

  return (
    <>
      <header className="topbar">
        <h1 className="row" style={{ gap: 8 }}>
          <img src="/favicon.svg" alt="" width={26} height={26} style={{ borderRadius: 6 }} />
          Tent
        </h1>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
      </header>
      {tab === 'Dashboard' && <Dashboard />}
      {tab === 'History' && <History />}
      {tab === 'Planner' && <Planner />}
      {tab === 'Settings' && <Settings />}
    </>
  )
}

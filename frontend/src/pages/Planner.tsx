import { FormEvent, useEffect, useState } from 'react'
import { api, Plant, PlantEvent } from '../api'

const EVENT_ICONS: Record<string, string> = {
  water: '💧',
  feed: '🧪',
  note: '📝',
  transplant: '🪴',
  harvest: '✂️',
}

export default function Planner() {
  const [plants, setPlants] = useState<Plant[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [logFor, setLogFor] = useState<Plant | null>(null)

  const load = () => api.plants().then(setPlants).catch(() => {})
  useEffect(() => {
    load()
  }, [])

  return (
    <>
      <div className="row spread section" style={{ marginTop: 0 }}>
        <h2 style={{ margin: 0 }}>Plants</h2>
        <button className="btn primary" onClick={() => setShowAdd(true)}>
          + Add plant
        </button>
      </div>

      {plants.length === 0 && <p className="muted">Nothing planted yet.</p>}

      <div className="grid">
        {plants.map((p) => (
          <PlantCard key={p.id} plant={p} onLog={() => setLogFor(p)} onChanged={load} />
        ))}
      </div>

      {showAdd && <AddPlantDialog onClose={() => setShowAdd(false)} onSaved={load} />}
      {logFor && (
        <LogEventDialog plant={logFor} allPlants={plants} onClose={() => setLogFor(null)} onSaved={load} />
      )}
    </>
  )
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null
  return Math.floor((Date.now() - new Date(iso + 'T00:00:00').getTime()) / 86400000)
}

function PlantCard({ plant, onLog, onChanged }: { plant: Plant; onLog: () => void; onChanged: () => void }) {
  const age = daysSince(plant.planted_at)
  const events = plant.events ?? []
  const lastWater = events.find((e) => e.type === 'water' || e.type === 'feed')

  const archive = async () => {
    if (!confirm(`Archive ${plant.name}?`)) return
    await api.updatePlant(plant.id, { archived: true })
    onChanged()
  }

  return (
    <div className="card">
      <div className="row spread">
        <h3>🌿 {plant.name}</h3>
        <span className="sub">{plant.medium}</span>
      </div>
      {plant.variety && <div className="sub">{plant.variety}</div>}
      <div className="hero" style={{ fontSize: 24 }}>
        {age != null ? `day ${age}` : '—'}
      </div>
      <div className="sub">
        planted {plant.planted_at ?? '?'}
        {lastWater &&
          ` · last ${lastWater.type} ${new Date(lastWater.ts + 'Z').toLocaleDateString([], {
            day: 'numeric',
            month: 'short',
          })}`}
      </div>

      {events.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary className="small muted" style={{ cursor: 'pointer' }}>
            {events.length} event{events.length === 1 ? '' : 's'}
          </summary>
          <EventList events={events} onChanged={onChanged} />
        </details>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={onLog}>
          + Log event
        </button>
        <button className="btn danger" onClick={archive}>
          Archive
        </button>
      </div>
    </div>
  )
}

function EventList({ events, onChanged }: { events: PlantEvent[]; onChanged: () => void }) {
  const remove = async (id: number) => {
    if (!confirm('Delete this event?')) return
    await api.deleteEvent(id)
    onChanged()
  }
  return (
    <table className="plain" style={{ marginTop: 6 }}>
      <tbody>
        {events.map((e) => (
          <tr key={e.id}>
            <td>{EVENT_ICONS[e.type] ?? '•'}</td>
            <td className="small">
              {new Date(e.ts + 'Z').toLocaleDateString([], { day: 'numeric', month: 'short' })}
            </td>
            <td className="small">
              {e.type}
              {e.amount_l != null && ` ${e.amount_l}L`}
              {e.mix && ` · ${e.mix}`}
              {e.ph != null && ` · pH ${e.ph}`}
              {e.notes && ` · ${e.notes}`}
            </td>
            <td>
              <button className="btn danger" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => remove(e.id)}>
                ×
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function AddPlantDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: '',
    variety: '',
    medium: 'soil',
    planted_at: new Date().toISOString().slice(0, 10),
    notes: '',
  })

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    await api.createPlant(form)
    onSaved()
    onClose()
  }

  return (
    <dialog open>
      <form onSubmit={submit}>
        <h3 style={{ margin: 0 }}>Add plant</h3>
        <div className="form-grid">
          <label className="field wide">
            Name
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="field">
            Variety / strain
            <input value={form.variety} onChange={(e) => setForm({ ...form, variety: e.target.value })} />
          </label>
          <label className="field">
            Medium
            <input value={form.medium} onChange={(e) => setForm({ ...form, medium: e.target.value })} />
          </label>
          <label className="field">
            Planted on
            <input
              type="date"
              value={form.planted_at}
              onChange={(e) => setForm({ ...form, planted_at: e.target.value })}
            />
          </label>
          <label className="field wide">
            Notes
            <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </label>
        </div>
        <div className="row">
          <button className="btn primary" type="submit">
            Save
          </button>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  )
}

function LogEventDialog({
  plant,
  allPlants,
  onClose,
  onSaved,
}: {
  plant: Plant
  allPlants: Plant[]
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({ type: 'water', amount_l: '', mix: '', ph: '', notes: '' })
  const [alsoIds, setAlsoIds] = useState<number[]>([])
  const others = allPlants.filter((p) => p.id !== plant.id)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    await api.addEvent(plant.id, {
      type: form.type,
      amount_l: form.amount_l ? Number(form.amount_l) : null,
      mix: form.mix,
      ph: form.ph ? Number(form.ph) : null,
      notes: form.notes,
      plant_ids: alsoIds,
    })
    onSaved()
    onClose()
  }

  return (
    <dialog open>
      <form onSubmit={submit}>
        <h3 style={{ margin: 0 }}>Log event — {plant.name}</h3>
        <div className="form-grid">
          <label className="field">
            Type
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="water">Water</option>
              <option value="feed">Feed</option>
              <option value="note">Note</option>
              <option value="transplant">Transplant</option>
              <option value="harvest">Harvest</option>
            </select>
          </label>
          <label className="field">
            Amount (L)
            <input
              type="number"
              step="0.1"
              value={form.amount_l}
              onChange={(e) => setForm({ ...form, amount_l: e.target.value })}
            />
          </label>
          <label className="field wide">
            Water / mix (what was in it)
            <input
              placeholder="e.g. tap water + BioGrow 2ml/L"
              value={form.mix}
              onChange={(e) => setForm({ ...form, mix: e.target.value })}
            />
          </label>
          <label className="field">
            pH
            <input type="number" step="0.1" value={form.ph} onChange={(e) => setForm({ ...form, ph: e.target.value })} />
          </label>
          <label className="field wide">
            Notes
            <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </label>
          {others.length > 0 && (
            <div className="field wide">
              Also apply to
              <div className="row">
                {others.map((p) => (
                  <label key={p.id} className="row small" style={{ gap: 4 }}>
                    <input
                      type="checkbox"
                      checked={alsoIds.includes(p.id)}
                      onChange={(e) =>
                        setAlsoIds(e.target.checked ? [...alsoIds, p.id] : alsoIds.filter((id) => id !== p.id))
                      }
                    />
                    {p.name}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="row">
          <button className="btn primary" type="submit">
            Save
          </button>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  )
}

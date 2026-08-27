import { useEffect, useRef, useState } from 'react'
import { api, Device } from '../api'

const ROLE_ICONS: Record<string, string> = {
  light: '💡',
  heater: '🔥',
  humidifier: '💧',
  exhaust: '🌀',
  energy: '⚡',
  other: '🔌',
}

export default function Dashboard() {
  const [devices, setDevices] = useState<Device[]>([])
  const [error, setError] = useState('')
  const timer = useRef<number>()

  const load = async () => {
    try {
      setDevices(await api.devices())
      setError('')
    } catch (e: any) {
      setError(e.message)
    }
  }

  useEffect(() => {
    load()
    timer.current = window.setInterval(load, 2000)
    return () => window.clearInterval(timer.current)
  }, [])

  if (error) return <p className="error-text">Backend unreachable: {error}</p>
  if (devices.length === 0)
    return (
      <p className="muted">
        No devices yet — add your ESP32, Wiz plugs, Tapo plug and Dreo humidifier in Settings.
      </p>
    )

  return (
    <div className="grid">
      {devices.map((d) =>
        d.kind === 'esp32_fan' ? (
          // ESP32 renders as two cards: temperature + fan, like the old app
          <TempAndFanCards key={d.id} device={d} onChanged={load} />
        ) : (
          <DeviceCard key={d.id} device={d} onChanged={load} />
        ),
      )}
    </div>
  )
}

function TempAndFanCards({ device, onChanged }: { device: Device; onChanged: () => void }) {
  const s = device.status
  return (
    <>
      <div className="card">
        <div className="row spread">
          <h3>🌡️ Temperature</h3>
          <span className={`dot ${s?.available ? 'on' : 'err'}`} />
        </div>
        {!s?.available && <p className="error-text small">{s?.error || 'offline'}</p>}
        {s?.available && (
          <>
            {(s.sensors ?? []).map((sensor) => (
              <div key={sensor.address} className="row spread" style={{ margin: '10px 0' }}>
                <span className="sub" style={{ fontSize: 14 }}>{sensor.name}</span>
                <span style={{ fontSize: 26, fontWeight: 650 }}>
                  {sensor.valid && sensor.temp_c != null ? `${sensor.temp_c.toFixed(1)} °C` : '—'}
                </span>
              </div>
            ))}
            {(s.sensors ?? []).length === 0 && (
              <p className="muted small">No sensors detected — plug one in and re-scan in Settings.</p>
            )}
          </>
        )}
        {s?.updated && <div className="sub" style={{ marginTop: 8 }}>updated {s.updated.replace('T', ' ')}</div>}
      </div>
      <DeviceCard device={device} onChanged={onChanged} />
    </>
  )
}

function DeviceCard({ device, onChanged }: { device: Device; onChanged: () => void }) {
  const s = device.status
  const icon = ROLE_ICONS[device.role] ?? '🔌'
  const [busy, setBusy] = useState(false)

  const doAction = async (action: string, value?: number) => {
    setBusy(true)
    try {
      await api.action(device.id, action, value)
      onChanged()
    } catch (e: any) {
      alert(`Command failed: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <div className="row spread">
        <h3>
          {icon} {device.name}
        </h3>
        <span className={`dot ${s?.available ? (s.is_on || device.kind === 'esp32_fan' ? 'on' : 'off') : 'err'}`} />
      </div>

      {!s?.available && <p className="error-text small">{s?.error || 'offline'}</p>}

      {device.kind === 'esp32_fan' && s?.available && <FanBody device={device} />}

      {device.kind === 'wiz' && s?.available && (
        <>
          <div className="hero">{s.is_on ? 'ON' : 'OFF'}</div>
          <button className="btn" disabled={busy} onClick={() => doAction(s.is_on ? 'off' : 'on')}>
            Turn {s.is_on ? 'off' : 'on'}
          </button>
        </>
      )}

      {device.kind === 'tapo' && s?.available && (
        <>
          <div className="hero">
            {s.power_w ?? 0} <small>W now</small>
          </div>
          <div className="sub">
            {s.today_kwh ?? 0} kWh today · {s.is_on ? 'on' : 'off'}
          </div>
          <div style={{ marginTop: 8 }}>
            <button className="btn" disabled={busy} onClick={() => doAction(s.is_on ? 'off' : 'on')}>
              Turn {s.is_on ? 'off' : 'on'}
            </button>
          </div>
        </>
      )}

      {device.kind === 'dreo' && s?.available && (
        <>
          <div className="hero">
            {s.humidity ?? '—'}
            <small>% RH</small>
          </div>
          <div className="sub">
            {s.is_on ? (s.is_working ? 'misting' : 'idle') : 'off'}
            {s.target_humidity != null && ` · target ${s.target_humidity}%`}
            {s.mode && ` · ${s.mode}`}
          </div>
        </>
      )}

      {s?.updated && <div className="sub" style={{ marginTop: 8 }}>updated {s.updated.replace('T', ' ')}</div>}
    </div>
  )
}

function signalLabel(rssi?: number): string {
  if (rssi == null) return '—'
  if (rssi >= -55) return `Strong (${rssi})`
  if (rssi >= -70) return `Good (${rssi})`
  if (rssi >= -80) return `Weak (${rssi})`
  return `Poor (${rssi})`
}

function FanBody({ device }: { device: Device }) {
  const s = device.status!

  return (
    <div className="metrics" style={{ borderTop: 'none', paddingTop: 0, marginTop: 6, gridTemplateColumns: '1fr 1fr' }}>
      <div className="metric">
        <span className="metric-label">Speed</span>
        <span className="metric-value">{s.speed ?? '—'}%</span>
      </div>
      <div className="metric">
        <span className="metric-label">Signal</span>
        <span className="metric-value">{signalLabel(s.rssi)}</span>
      </div>
    </div>
  )
}

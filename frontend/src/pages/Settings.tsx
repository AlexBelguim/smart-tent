import { FormEvent, useEffect, useState } from 'react'
import { api, Device, getPin, setPin } from '../api'

function PinGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [pin, setPinInput] = useState('')
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      setPin(pin)
      await api.verifyPin(pin)
      onUnlocked()
    } catch {
      setPin('')
      setError('Wrong PIN')
    }
  }

  return (
    <form onSubmit={submit} className="card" style={{ maxWidth: 320, margin: '60px auto', textAlign: 'center' }}>
      <h3>🔒 Settings locked</h3>
      <input
        type="password"
        inputMode="numeric"
        maxLength={8}
        autoFocus
        value={pin}
        onChange={(e) => setPinInput(e.target.value)}
        placeholder="PIN"
        style={{ textAlign: 'center', fontSize: 20, letterSpacing: 6, width: 140, margin: '12px 0' }}
      />
      {error && <p className="error-text">{error}</p>}
      <div>
        <button className="btn primary" type="submit">
          Unlock
        </button>
      </div>
    </form>
  )
}

const ROLES = ['light', 'heater', 'humidifier', 'exhaust', 'energy', 'other']
const KINDS: { value: Device['kind']; label: string }[] = [
  { value: 'wiz', label: 'Wiz plug' },
  { value: 'esp32_fan', label: 'ESP32 fan + temp' },
  { value: 'tapo', label: 'Tapo P110 (energy)' },
  { value: 'dreo', label: 'Dreo humidifier (cloud)' },
]

export default function Settings() {
  const [unlocked, setUnlocked] = useState(false)
  useEffect(() => {
    if (getPin()) {
      api.verifyPin(getPin()).then(() => setUnlocked(true)).catch(() => setPin(''))
    }
  }, [])

  if (!unlocked) return <PinGate onUnlocked={() => setUnlocked(true)} />
  return <SettingsInner />
}

function SettingsInner() {
  const [devices, setDevices] = useState<Device[]>([])
  const [editing, setEditing] = useState<Device | 'new' | null>(null)
  const [found, setFound] = useState<{ ip: string; mac: string | null; registered: boolean }[] | null>(null)
  const [discovering, setDiscovering] = useState(false)

  const load = () => api.devices().then(setDevices).catch(() => {})
  useEffect(() => {
    load()
  }, [])

  const discover = async () => {
    setDiscovering(true)
    try {
      setFound(await api.discoverWiz())
    } catch {
      setFound([])
    } finally {
      setDiscovering(false)
    }
  }

  return (
    <>
      <div className="section" style={{ marginTop: 0 }}>
        <div className="row spread">
          <h2>Devices</h2>
          <div className="row">
            <button className="btn" onClick={discover} disabled={discovering}>
              {discovering ? 'Scanning…' : '🔍 Discover Wiz plugs'}
            </button>
            <button className="btn primary" onClick={() => setEditing('new')}>
              + Add device
            </button>
          </div>
        </div>

        {found && (
          <div className="card" style={{ margin: '10px 0' }}>
            <h3>Wiz discovery</h3>
            {found.length === 0 && <p className="muted small">Nothing found (UDP broadcast needs host networking in Docker).</p>}
            {found.map((f) => (
              <div key={f.ip} className="row spread" style={{ padding: '4px 0' }}>
                <span className="small">
                  {f.ip} {f.mac && <span className="muted">({f.mac})</span>}
                </span>
                {f.registered ? (
                  <span className="muted small">already added</span>
                ) : (
                  <button
                    className="btn"
                    onClick={async () => {
                      await api.createDevice({ kind: 'wiz', name: `Wiz ${f.ip.split('.').pop()}`, ip: f.ip, role: 'other' })
                      load()
                      discover()
                    }}
                  >
                    Add
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <table className="plain">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>IP</th>
              <th>Role</th>
              <th>Automation</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td>
                  {d.name} {!d.enabled && <span className="muted small">(disabled)</span>}
                </td>
                <td className="muted">{d.kind}</td>
                <td className="muted">{d.ip || '—'}</td>
                <td>{d.role}</td>
                <td className="small muted">{automationSummary(d)}</td>
                <td>
                  <button className="btn" style={{ padding: '3px 10px' }} onClick={() => setEditing(d)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {devices.some((d) => d.kind === 'esp32_fan') && (
        <SensorSection espDevices={devices.filter((d) => d.kind === 'esp32_fan')} />
      )}

      <AppSettings />

      {editing && (
        <DeviceDialog
          device={editing === 'new' ? null : editing}
          espDevices={devices.filter((d) => d.kind === 'esp32_fan')}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load()
          }}
        />
      )}
    </>
  )
}

function automationSummary(d: Device): string {
  const parts: string[] = []
  const s = d.config?.schedule
  if (s?.enabled) parts.push(`on ${s.on} → off ${s.off}`)
  const h = d.config?.hysteresis
  if (h?.enabled) parts.push(`heat ${h.day_temp}°/${h.night_temp}° (−${h.hyst_on}/+${h.hyst_off})`)
  const a = d.config?.auto
  if (a?.enabled) parts.push(`fan ${a.day_speed}%/${a.night_speed}%${a.humidity_override ? ' +hum' : ''}`)
  return parts.join(' · ') || '—'
}

function DeviceDialog({
  device,
  espDevices,
  onClose,
  onSaved,
}: {
  device: Device | null
  espDevices: Device[]
  onClose: () => void
  onSaved: () => void
}) {
  const hyst = device?.config?.hysteresis ?? {}
  const auto = device?.config?.auto ?? {}
  const [form, setForm] = useState({
    kind: device?.kind ?? 'wiz',
    name: device?.name ?? '',
    ip: device?.ip ?? '',
    role: device?.role ?? 'other',
    enabled: device?.enabled ?? true,
    auth_code: device?.config?.auth_code ?? '',
    email: device?.config?.email ?? '',
    password: device?.config?.password ?? '',
    // wiz: schedule
    sched_enabled: device?.config?.schedule?.enabled ?? false,
    sched_on: device?.config?.schedule?.on ?? '06:00',
    sched_off: device?.config?.schedule?.off ?? '00:00',
    // wiz: thermostat (heater)
    hyst_enabled: hyst.enabled ?? false,
    hyst_day_temp: hyst.day_temp ?? 22,
    hyst_night_temp: hyst.night_temp ?? 20,
    hyst_on: hyst.hyst_on ?? 0.5,
    hyst_off: hyst.hyst_off ?? 2.0,
    hyst_source: hyst.source_device_id ?? espDevices[0]?.id ?? '',
    hyst_sensors: (hyst.sensors ?? (hyst.source_label ? [hyst.source_label] : [])) as string[],
    // esp32: auto fan control
    auto_enabled: auto.enabled ?? false,
    auto_day: auto.day_speed ?? 75,
    auto_night: auto.night_speed ?? 15,
    auto_hum: auto.humidity_override ?? true,
    auto_hum_on: auto.hum_on ?? 10,
    auto_hum_off: auto.hum_off ?? 5,
  })
  const [error, setError] = useState('')

  const isWiz = form.kind === 'wiz'
  const isEsp = form.kind === 'esp32_fan'
  const needsCreds = form.kind === 'tapo' || form.kind === 'dreo'
  const sourceSensors = espDevices.find((d) => d.id === Number(form.hyst_source))?.status?.sensors ?? []

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const config: Record<string, any> = { ...(device?.config ?? {}) }
    if (isEsp) {
      config.auth_code = form.auth_code
      config.auto = {
        enabled: form.auto_enabled,
        day_speed: Number(form.auto_day),
        night_speed: Number(form.auto_night),
        humidity_override: form.auto_hum,
        hum_on: Number(form.auto_hum_on),
        hum_off: Number(form.auto_hum_off),
      }
    }
    if (needsCreds) {
      if (form.email) config.email = form.email
      if (form.password) config.password = form.password
    }
    if (isWiz) {
      config.schedule = { enabled: form.sched_enabled, on: form.sched_on, off: form.sched_off }
      config.hysteresis = {
        enabled: form.hyst_enabled,
        day_temp: Number(form.hyst_day_temp),
        night_temp: Number(form.hyst_night_temp),
        hyst_on: Number(form.hyst_on),
        hyst_off: Number(form.hyst_off),
        source_device_id: Number(form.hyst_source) || null,
        sensors: form.hyst_sensors,
      }
    }
    const payload = {
      kind: form.kind as Device['kind'],
      name: form.name,
      ip: form.ip,
      role: form.role,
      enabled: form.enabled,
      config,
    }
    try {
      if (device) await api.updateDevice(device.id, payload)
      else await api.createDevice(payload)
      onSaved()
    } catch (err: any) {
      setError(err.message)
    }
  }

  const remove = async () => {
    if (!device) return
    if (!confirm(`Remove ${device.name}? History for it stays in the database.`)) return
    await api.deleteDevice(device.id)
    onSaved()
  }

  return (
    <dialog open>
      <form onSubmit={submit}>
        <h3 style={{ margin: 0 }}>{device ? `Edit ${device.name}` : 'Add device'}</h3>
        <div className="form-grid">
          <label className="field">
            Type
            <select
              value={form.kind}
              disabled={!!device}
              onChange={(e) => setForm({ ...form, kind: e.target.value as Device['kind'] })}
            >
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Name
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          {form.kind !== 'dreo' && (
            <label className="field">
              IP address
              <input value={form.ip} onChange={(e) => setForm({ ...form, ip: e.target.value })} />
            </label>
          )}
          <label className="field">
            Role
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {ROLES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          {isEsp && (
            <label className="field">
              Access code
              <input value={form.auth_code} onChange={(e) => setForm({ ...form, auth_code: e.target.value })} />
            </label>
          )}
          {needsCreds && (
            <>
              <label className="field">
                Account email
                <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </label>
              <label className="field">
                Account password
                <input
                  type="password"
                  value={form.password}
                  placeholder={device?.config?.password ? '(unchanged)' : ''}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              </label>
              <p className="muted small wide" style={{ margin: 0 }}>
                Leave blank to use TAPO_/DREO_ env variables from the container instead.
              </p>
            </>
          )}
          <label className="field">
            Enabled
            <select
              value={form.enabled ? 'yes' : 'no'}
              onChange={(e) => setForm({ ...form, enabled: e.target.value === 'yes' })}
            >
              <option value="yes">yes</option>
              <option value="no">no</option>
            </select>
          </label>

          {isEsp && device && (
            <div className="wide" style={{ borderTop: '1px solid var(--grid)', paddingTop: 10 }}>
              <ManualSpeed device={device} disabled={form.auto_enabled} />
            </div>
          )}
          {isWiz && device && (
            <div className="wide" style={{ borderTop: '1px solid var(--grid)', paddingTop: 10 }}>
              <TestSwitch device={device} />
            </div>
          )}
          {isEsp && (
            <>
              <div className="wide" style={{ borderTop: '1px solid var(--grid)', paddingTop: 10 }}>
                <label className="row small" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={form.auto_enabled}
                    onChange={(e) => setForm({ ...form, auto_enabled: e.target.checked })}
                  />
                  Auto fan control (day/night follows the grow light)
                </label>
              </div>
              {form.auto_enabled && (
                <>
                  <label className="field">
                    Day speed %
                    <input
                      type="number" min={0} max={100}
                      value={form.auto_day}
                      onChange={(e) => setForm({ ...form, auto_day: e.target.value as any })}
                    />
                  </label>
                  <label className="field">
                    Night speed %
                    <input
                      type="number" min={0} max={100}
                      value={form.auto_night}
                      onChange={(e) => setForm({ ...form, auto_night: e.target.value as any })}
                    />
                  </label>
                  <div className="wide">
                    <label className="row small" style={{ gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={form.auto_hum}
                        onChange={(e) => setForm({ ...form, auto_hum: e.target.checked })}
                      />
                      Humidity override → 100% (uses the Dreo's humidity vs its target)
                    </label>
                  </div>
                  {form.auto_hum && (
                    <>
                      <label className="field">
                        Boost at target + %
                        <input
                          type="number"
                          value={form.auto_hum_on}
                          onChange={(e) => setForm({ ...form, auto_hum_on: e.target.value as any })}
                        />
                      </label>
                      <label className="field">
                        Release at target + %
                        <input
                          type="number"
                          value={form.auto_hum_off}
                          onChange={(e) => setForm({ ...form, auto_hum_off: e.target.value as any })}
                        />
                      </label>
                    </>
                  )}
                </>
              )}
            </>
          )}

          {isWiz && (
            <>
              <div className="wide" style={{ borderTop: '1px solid var(--grid)', paddingTop: 10 }}>
                <label className="row small" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={form.sched_enabled}
                    onChange={(e) => setForm({ ...form, sched_enabled: e.target.checked })}
                  />
                  Daily schedule (e.g. grow light)
                </label>
              </div>
              {form.sched_enabled && (
                <>
                  <label className="field">
                    On at
                    <input type="time" value={form.sched_on} onChange={(e) => setForm({ ...form, sched_on: e.target.value })} />
                  </label>
                  <label className="field">
                    Off at
                    <input type="time" value={form.sched_off} onChange={(e) => setForm({ ...form, sched_off: e.target.value })} />
                  </label>
                </>
              )}
              <div className="wide">
                <label className="row small" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={form.hyst_enabled}
                    onChange={(e) => setForm({ ...form, hyst_enabled: e.target.checked })}
                  />
                  Thermostat (heater) — ON below target − on-hyst, OFF above target + off-hyst
                </label>
              </div>
              {form.hyst_enabled && (
                <>
                  <label className="field">
                    Day target °C
                    <input
                      type="number" step="0.5"
                      value={form.hyst_day_temp}
                      onChange={(e) => setForm({ ...form, hyst_day_temp: e.target.value as any })}
                    />
                  </label>
                  <label className="field">
                    Night target °C
                    <input
                      type="number" step="0.5"
                      value={form.hyst_night_temp}
                      onChange={(e) => setForm({ ...form, hyst_night_temp: e.target.value as any })}
                    />
                  </label>
                  <label className="field">
                    ON hysteresis (− °C)
                    <input
                      type="number" step="0.1"
                      value={form.hyst_on}
                      onChange={(e) => setForm({ ...form, hyst_on: e.target.value as any })}
                    />
                  </label>
                  <label className="field">
                    OFF hysteresis (+ °C)
                    <input
                      type="number" step="0.1"
                      value={form.hyst_off}
                      onChange={(e) => setForm({ ...form, hyst_off: e.target.value as any })}
                    />
                  </label>
                  <label className="field">
                    Temperature source
                    <select
                      value={form.hyst_source}
                      onChange={(e) => setForm({ ...form, hyst_source: e.target.value as any, hyst_sensors: [] })}
                    >
                      {espDevices.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="field">
                    Sensors (none checked = all)
                    <div className="row" style={{ marginTop: 4 }}>
                      {sourceSensors.map((s) => (
                        <label key={s.address} className="row small" style={{ gap: 4 }}>
                          <input
                            type="checkbox"
                            checked={form.hyst_sensors.includes(s.address)}
                            onChange={(e) =>
                              setForm({
                                ...form,
                                hyst_sensors: e.target.checked
                                  ? [...form.hyst_sensors, s.address]
                                  : form.hyst_sensors.filter((a) => a !== s.address),
                              })
                            }
                          />
                          {s.name}
                          {s.valid && s.temp_c != null && (
                            <span className="muted">({s.temp_c.toFixed(1)}°)</span>
                          )}
                        </label>
                      ))}
                      {sourceSensors.length === 0 && <span className="muted small">no sensors detected</span>}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>
        {error && <p className="error-text">{error}</p>}
        <div className="row">
          <button className="btn primary" type="submit">
            Save
          </button>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          {device && (
            <button className="btn danger" type="button" onClick={remove} style={{ marginLeft: 'auto' }}>
              Remove
            </button>
          )}
        </div>
      </form>
    </dialog>
  )
}

function TestSwitch({ device }: { device: Device }) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState('')

  const test = async () => {
    setTesting(true)
    setResult('')
    try {
      await api.action(device.id, 'test')
      setResult('✓ toggled and restored')
    } catch (e: any) {
      setResult(`✗ ${e.message}`)
    } finally {
      setTesting(false)
      setTimeout(() => setResult(''), 4000)
    }
  }

  return (
    <div className="row spread">
      <span className="small" style={{ color: 'var(--ink-2)' }}>
        Test switch — toggles for 5 s, then puts it back
      </span>
      <span className="row" style={{ gap: 8 }}>
        {result && <span className="small">{result}</span>}
        <button className="btn" type="button" disabled={testing} onClick={test}>
          {testing ? 'Testing…' : '⚡ Test'}
        </button>
      </span>
    </div>
  )
}

function modeLabel(mode?: string): string {
  if (mode === 'day') return '☀️ Day'
  if (mode === 'night') return '🌙 Night'
  if (mode === 'humidity boost') return '💨 Boost'
  return '✋ Manual'
}

function ManualSpeed({ device, disabled }: { device: Device; disabled: boolean }) {
  const [speed, setSpeed] = useState(device.status?.speed ?? 0)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  const apply = async () => {
    setSending(true)
    try {
      await api.action(device.id, 'speed', speed)
      setSent(true)
      setTimeout(() => setSent(false), 1500)
    } catch (e: any) {
      alert(`Command failed: ${e.message}`)
    } finally {
      setSending(false)
    }
  }

  return (
    <div>
      <div className="row spread small" style={{ marginBottom: 6, color: 'var(--ink-2)' }}>
        <span>
          Manual fan speed {disabled && <span className="muted">(inactive while auto is on)</span>}
        </span>
        <span>
          Current mode: <b>{modeLabel(device.status?.mode)}</b>
        </span>
      </div>
      <div className="row">
        <input
          type="range" min={0} max={100} step={5} value={speed} style={{ flex: 1 }}
          disabled={disabled}
          onChange={(e) => setSpeed(Number(e.target.value))}
        />
        <span style={{ width: 42, textAlign: 'right' }}>{speed}%</span>
        <button className="btn" type="button" disabled={disabled || sending} onClick={apply}>
          {sent ? '✓' : 'Set'}
        </button>
      </div>
    </div>
  )
}

type SensorRow = {
  deviceId: number
  deviceName: string
  address: string
  name: string
  temp_c: number | null
  valid: boolean
}

function SensorSection({ espDevices }: { espDevices: Device[] }) {
  const toRows = (devs: Device[]): SensorRow[] =>
    devs.flatMap((d) =>
      (d.status?.sensors ?? []).map((s) => ({
        deviceId: d.id,
        deviceName: d.name,
        address: s.address,
        name: s.name,
        temp_c: s.temp_c,
        valid: s.valid,
      })),
    )

  const [rows, setRows] = useState<SensorRow[]>(() => toRows(espDevices))
  const [savedAddr, setSavedAddr] = useState('')
  const [scanning, setScanning] = useState(false)
  const multiEsp = espDevices.length > 1

  const setName = (address: string, name: string) =>
    setRows(rows.map((r) => (r.address === address ? { ...r, name } : r)))

  const save = async (row: SensorRow) => {
    try {
      await api.renameSensor(row.deviceId, row.address, row.name)
      setSavedAddr(row.address)
      setTimeout(() => setSavedAddr(''), 1500)
    } catch (e: any) {
      alert(`Rename failed: ${e.message}`)
    }
  }

  const rescan = async () => {
    setScanning(true)
    try {
      const fresh: Device[] = []
      for (const d of espDevices) {
        const result = await api.detectSensors(d.id)
        fresh.push({ ...d, status: result.status })
      }
      setRows(toRows(fresh))
    } catch (e: any) {
      alert(`Scan failed: ${e.message}`)
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="section">
      <div className="row spread">
        <h2 style={{ margin: 0 }}>Temperature sensors</h2>
        <button className="btn" type="button" onClick={rescan} disabled={scanning}>
          {scanning ? 'Scanning…' : '🔄 Re-scan'}
        </button>
      </div>
      <p className="small muted" style={{ margin: '6px 0 10px' }}>
        Name each probe (e.g. “Inside”, “Outside”) — used on the dashboard, graphs and heater.
      </p>
      {rows.length === 0 ? (
        <p className="muted small">No sensors detected — plug one in and re-scan.</p>
      ) : (
        <table className="plain">
          <thead>
            <tr>
              <th>Name</th>
              <th>Reading</th>
              <th>Address</th>
              {multiEsp && <th>Device</th>}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.address}>
                <td>
                  <input value={r.name} onChange={(e) => setName(r.address, e.target.value)} />
                </td>
                <td style={{ fontWeight: 600 }}>{r.valid && r.temp_c != null ? `${r.temp_c.toFixed(1)} °C` : '—'}</td>
                <td className="muted">{r.address}</td>
                {multiEsp && <td className="muted">{r.deviceName}</td>}
                <td>
                  <button className="btn" style={{ padding: '3px 10px' }} type="button" onClick={() => save(r)}>
                    {savedAddr === r.address ? '✓' : 'Rename'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function AppSettings() {
  const [values, setValues] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    api.settings().then(setValues).catch(() => {})
  }, [])

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setValues(await api.saveSettings(values))
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const FIELDS: { key: string; label: string; hint: string }[] = [
    { key: 'kwh_price', label: 'Energy price / kWh', hint: 'used for cost graphs' },
    { key: 'currency', label: 'Currency symbol', hint: '' },
    { key: 'display_interval_s', label: 'Live update interval', hint: 'seconds between live view refreshes' },
    { key: 'poll_interval_s', label: 'History interval', hint: 'seconds between saved data points' },
    { key: 'dreo_interval_s', label: 'Dreo poll interval', hint: 'seconds between cloud polls' },
  ]

  return (
    <form onSubmit={save} className="section">
      <div className="row spread">
        <h2 style={{ margin: 0 }}>App settings</h2>
        <button className="btn primary" type="submit">
          {saved ? 'Saved ✓' : 'Save settings'}
        </button>
      </div>
      <table className="plain" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th>Setting</th>
            <th>Value</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {FIELDS.map((f) => (
            <tr key={f.key}>
              <td>{f.label}</td>
              <td>
                <input
                  style={{ maxWidth: 140 }}
                  value={values[f.key] ?? ''}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                />
              </td>
              <td className="muted small">{f.hint}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </form>
  )
}

import { useEffect, useMemo, useState } from 'react'
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from 'recharts'
import { api } from '../api'

const SERIES_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181']
const GRID = '#2c2c2a'
const MUTED = '#898781'
const SURFACE = '#1a1a19'

const RANGES = [
  { label: '24h', hours: 24 },
  { label: '3d', hours: 72 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
]

type Row = Record<string, number | string>

function mergeSeries(series: { label: string; device_id: number; points: [string, number][] }[]): {
  rows: Row[]
  keys: string[]
} {
  const byTs = new Map<number, Row>()
  const keys: string[] = []
  for (const s of series) {
    const key = s.label || `device ${s.device_id}`
    if (!keys.includes(key)) keys.push(key)
    for (const [iso, value] of s.points) {
      // bucket to the minute so multi-sensor samples from one poll align
      const t = Math.floor(new Date(iso).getTime() / 60000) * 60000
      const row = byTs.get(t) ?? { t }
      row[key] = value
      byTs.set(t, row)
    }
  }
  const rows = [...byTs.values()].sort((a, b) => (a.t as number) - (b.t as number))
  return { rows, keys }
}

function timeFormatter(hours: number) {
  return (t: number) => {
    const d = new Date(t)
    if (hours <= 24) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) +
      ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
}

const tooltipStyle = {
  backgroundColor: SURFACE,
  border: `1px solid rgba(255,255,255,0.1)`,
  borderRadius: 8,
  fontSize: 13,
}

function TimeSeriesChart({ metric, title, unit, hours, color }: {
  metric: string
  title: string
  unit: string
  hours: number
  color?: string
}) {
  const [data, setData] = useState<{ rows: Row[]; keys: string[] }>({ rows: [], keys: [] })

  useEffect(() => {
    api.history(metric, hours).then((r) => setData(mergeSeries(r.series))).catch(() => setData({ rows: [], keys: [] }))
  }, [metric, hours])

  if (data.rows.length === 0)
    return (
      <div className="chart-card">
        <h3>{title}</h3>
        <p className="muted small">No data yet.</p>
      </div>
    )

  const fmt = timeFormatter(hours)
  return (
    <div className="chart-card">
      <h3>{title}</h3>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={data.rows} margin={{ top: 4, right: 12, bottom: 0, left: -12 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']}
            tickFormatter={fmt} stroke={MUTED} tick={{ fontSize: 12 }} tickLine={false}
          />
          <YAxis stroke={MUTED} tick={{ fontSize: 12 }} tickLine={false} axisLine={false}
            unit={unit} domain={['auto', 'auto']} />
          <Tooltip
            labelFormatter={(t) => fmt(Number(t))}
            contentStyle={tooltipStyle}
            formatter={(v: number) => [`${Number(v).toFixed(1)}${unit}`, undefined]}
          />
          {data.keys.length > 1 && <Legend wrapperStyle={{ fontSize: 13 }} />}
          {data.keys.map((k, i) => (
            <Line
              key={k} dataKey={k} type="monotone" dot={false}
              stroke={color && data.keys.length === 1 ? color : SERIES_COLORS[i % SERIES_COLORS.length]}
              strokeWidth={2} connectNulls isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function EnergyChart() {
  const [days, setDays] = useState(30)
  const [data, setData] = useState<Awaited<ReturnType<typeof api.energyDaily>> | null>(null)

  useEffect(() => {
    api.energyDaily(days).then(setData).catch(() => setData(null))
  }, [days])

  const rows = useMemo(
    () => (data?.days ?? []).map((d) => ({ ...d, day: d.date.slice(5) })),
    [data],
  )

  return (
    <div className="chart-card">
      <div className="row spread">
        <h3>Daily energy</h3>
        <div className="pills" style={{ marginBottom: 0 }}>
          {[30, 90, 365].map((n) => (
            <button key={n} className={days === n ? 'active' : ''} onClick={() => setDays(n)}>
              {n}d
            </button>
          ))}
        </div>
      </div>
      {data && (
        <p className="small muted" style={{ margin: '4px 0 10px' }}>
          This month: <b style={{ color: 'var(--ink)' }}>{data.month_kwh} kWh</b> ({data.currency}
          {data.month_cost}) · All time: {data.total_kwh} kWh ({data.currency}
          {data.total_cost})
        </p>
      )}
      {rows.length === 0 ? (
        <p className="muted small">No energy data yet — add a Tapo P110 in Settings.</p>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={rows} margin={{ top: 4, right: 12, bottom: 0, left: -12 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="day" stroke={MUTED} tick={{ fontSize: 12 }} tickLine={false} />
            <YAxis stroke={MUTED} tick={{ fontSize: 12 }} tickLine={false} axisLine={false} unit=" kWh" />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v: number, name: string) => [name === 'kwh' ? `${v} kWh` : `${data?.currency}${v}`, name]}
            />
            <Bar dataKey="kwh" fill="#3987e5" radius={[4, 4, 0, 0]} maxBarSize={26} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

export default function History() {
  const [hours, setHours] = useState(24)

  return (
    <>
      <div className="pills">
        {RANGES.map((r) => (
          <button key={r.hours} className={hours === r.hours ? 'active' : ''} onClick={() => setHours(r.hours)}>
            {r.label}
          </button>
        ))}
      </div>
      <TimeSeriesChart metric="temp_c" title="Temperature" unit="°C" hours={hours} />
      <TimeSeriesChart metric="humidity" title="Humidity" unit="%" hours={hours} color="#199e70" />
      <TimeSeriesChart metric="power_w" title="Power draw" unit="W" hours={hours} />
      <TimeSeriesChart metric="fan_speed" title="Fan speed" unit="%" hours={hours} color="#d55181" />
      <EnergyChart />
    </>
  )
}

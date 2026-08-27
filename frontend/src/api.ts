export type DeviceStatus = {
  available: boolean
  error?: string
  updated?: string
  // esp32_fan
  speed?: number
  rssi?: number
  // mode: fan auto mode (manual|day|night|humidity boost) or Dreo mode — shared field below
  sensors?: { address: string; name: string; temp_c: number | null; valid: boolean }[]
  // wiz / tapo
  is_on?: boolean
  power_w?: number
  today_kwh?: number
  nickname?: string
  // dreo
  is_working?: boolean
  humidity?: number
  target_humidity?: number
  mode?: string
}

export type Device = {
  id: number
  kind: 'esp32_fan' | 'wiz' | 'tapo' | 'dreo'
  name: string
  ip: string
  role: string
  config: Record<string, any>
  enabled: boolean
  status?: DeviceStatus
}

export type Plant = {
  id: number
  name: string
  variety: string
  medium: string
  planted_at: string | null
  notes: string
  archived: boolean
  events?: PlantEvent[]
}

export type PlantEvent = {
  id: number
  plant_id: number
  ts: string
  type: string
  amount_l: number | null
  mix: string
  ph: number | null
  notes: string
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = body.detail || detail
    } catch {}
    throw new Error(detail)
  }
  return res.json()
}

export const api = {
  devices: () => request<Device[]>('/api/devices'),
  createDevice: (d: Partial<Device>) => request<Device>('/api/devices', { method: 'POST', body: JSON.stringify(d) }),
  updateDevice: (id: number, d: Partial<Device>) =>
    request<Device>(`/api/devices/${id}`, { method: 'PATCH', body: JSON.stringify(d) }),
  deleteDevice: (id: number) => request(`/api/devices/${id}`, { method: 'DELETE' }),
  action: (id: number, action: string, value?: number) =>
    request(`/api/devices/${id}/action`, { method: 'POST', body: JSON.stringify({ action, value }) }),
  discoverWiz: () => request<{ ip: string; mac: string | null; registered: boolean }[]>('/api/discover/wiz'),
  renameSensor: (deviceId: number, address: string, name: string) =>
    request(`/api/devices/${deviceId}/sensor_name`, { method: 'POST', body: JSON.stringify({ address, name }) }),
  detectSensors: (deviceId: number) =>
    request<{ sensors: { address: string; name: string }[]; status: DeviceStatus }>(
      `/api/devices/${deviceId}/detect_sensors`,
      { method: 'POST' },
    ),

  history: (metric: string, hours: number, deviceId?: number) =>
    request<{ series: { device_id: number; label: string; points: [string, number][] }[] }>(
      `/api/history?metric=${metric}&hours=${hours}${deviceId ? `&device_id=${deviceId}` : ''}`,
    ),
  energyDaily: (days: number) =>
    request<{
      days: { date: string; kwh: number; cost: number }[]
      month_kwh: number
      month_cost: number
      total_kwh: number
      total_cost: number
      kwh_price: number
      currency: string
    }>(`/api/energy/daily?days=${days}`),

  plants: () => request<Plant[]>('/api/plants'),
  createPlant: (p: Partial<Plant>) => request<Plant>('/api/plants', { method: 'POST', body: JSON.stringify(p) }),
  updatePlant: (id: number, p: Partial<Plant>) =>
    request<Plant>(`/api/plants/${id}`, { method: 'PATCH', body: JSON.stringify(p) }),
  deletePlant: (id: number) => request(`/api/plants/${id}`, { method: 'DELETE' }),
  addEvent: (plantId: number, e: Partial<PlantEvent> & { plant_ids?: number[] }) =>
    request(`/api/plants/${plantId}/events`, { method: 'POST', body: JSON.stringify(e) }),
  deleteEvent: (id: number) => request(`/api/events/${id}`, { method: 'DELETE' }),

  settings: () => request<Record<string, string>>('/api/settings'),
  saveSettings: (values: Record<string, string>) =>
    request<Record<string, string>>('/api/settings', { method: 'PUT', body: JSON.stringify({ values }) }),
}

/**
 * Smart Tent Dashboard - EC & Water (Multi-Probe MUX)
 * 
 * View Mode: Shows only enabled probes as cards
 * Edit Mode: Configure all 16 MUX channels
 */

const PROBE_COLORS = [
    '#4ade80', '#60a5fa', '#f472b6', '#fb923c',
    '#a78bfa', '#34d399', '#fbbf24', '#f87171',
    '#38bdf8', '#c084fc', '#22d3ee', '#fb7185',
    '#a3e635', '#e879f9', '#2dd4bf', '#facc15'
];

let ecChart = null;
let currentHistoryHours = 168;
let isEditMode = false;
let channelsData = [];
let tempSensorsData = [];
let calibrateChannel = null;

// ============== STATUS FETCH ==============

async function fetchStatus() {
    try {
        const response = await fetch('/api/ec');
        const data = await response.json();
        updateUI(data);
    } catch (e) {
        console.error("Failed to fetch EC status", e);
        document.getElementById('statusBadge').className = 'badge offline';
        document.getElementById('statusBadge').textContent = 'Offline';
    }
}

async function fetchSettings() {
    try {
        const response = await fetch('/api/ec/settings');
        const data = await response.json();
        if (data.interval) {
            document.getElementById('newIntervalInput').value = data.interval;
        }
    } catch (e) {
        console.error("Failed to fetch EC settings", e);
    }
}

async function fetchHistory(hours) {
    if (hours) currentHistoryHours = hours;
    try {
        const response = await fetch(`/api/ec/history?hours=${currentHistoryHours}`);
        const history = await response.json();
        updateChart(history);
    } catch (e) {
        console.error("Failed to fetch EC history", e);
    }
}

// ============== UI UPDATE ==============

function updateUI(data) {
    const badgeEl = document.getElementById('statusBadge');

    if (!data.available) {
        badgeEl.className = 'badge offline';
        badgeEl.textContent = 'Offline';
        return;
    }

    badgeEl.className = 'badge online';
    badgeEl.textContent = 'Online';

    channelsData = data.channels || [];
    tempSensorsData = data.temp_sensors || [];

    if (!isEditMode) {
        renderProbeCards();
    } else {
        // Update live readings in edit mode
        updateEditModeReadings();
    }
}

// ============== VIEW MODE: PROBE CARDS ==============

function renderProbeCards() {
    const grid = document.getElementById('probeCardsGrid');
    const enabledProbes = channelsData.filter(ch => ch.enabled);

    if (enabledProbes.length === 0) {
        grid.innerHTML = `
            <div class="probe-card probe-card--empty">
                <div class="probe-card__empty-msg">
                    <span style="font-size: 2rem;">🔌</span>
                    <p>No probes enabled yet</p>
                    <p style="font-size: 0.8rem; opacity: 0.6;">Tap <strong>Edit</strong> to configure your probes</p>
                </div>
            </div>`;
        return;
    }

    grid.innerHTML = enabledProbes.map(ch => {
        const status = ch.status || 'UNKNOWN';
        const statusClass = getStatusClass(status);
        const statusLabel = getStatusLabel(status);
        const color = PROBE_COLORS[ch.id % PROBE_COLORS.length];
        const ec = ch.ec_us_cm ? Math.round(ch.ec_us_cm) : '--';
        const temp = ch.temp_c > -100 ? `${ch.temp_c.toFixed(1)}°C` : '';
        const kf = ch.k_factor ? ch.k_factor.toFixed(2) : '--';

        return `
        <div class="probe-card ${statusClass}" style="--probe-color: ${color}">
            <div class="probe-card__header">
                <div class="probe-card__color-dot" style="background: ${color};"></div>
                <span class="probe-card__name">${escapeHtml(ch.name)}</span>
                <span class="probe-card__channel">CH${ch.id}</span>
            </div>
            <div class="probe-card__ec">
                <span class="probe-card__ec-value">${ec}</span>
                <span class="probe-card__ec-unit">µS/cm</span>
            </div>
            <div class="probe-card__details">
                ${temp ? `<span class="probe-card__temp">🌡 ${temp}</span>` : ''}
                <span class="probe-card__status ${statusClass}">${statusLabel}</span>
            </div>
            <div class="probe-card__footer">
                <span class="probe-card__kf">K: ${kf}</span>
                <button class="probe-card__test-btn" onclick="testSingleProbe(${ch.id})" title="Test this probe">⚡ Test</button>
            </div>
        </div>`;
    }).join('');
}

function getStatusClass(status) {
    switch (status) {
        case 'OPTIMAL': return 'status--optimal';
        case 'HUNGRY': return 'status--hungry';
        case 'TOO_SALTY': return 'status--salty';
        case 'WATER_LOW': return 'status--empty';
        default: return '';
    }
}

function getStatusLabel(status) {
    switch (status) {
        case 'OPTIMAL': return '✅ Optimal';
        case 'HUNGRY': return '🍽️ Hungry';
        case 'TOO_SALTY': return '🧂 Too Salty';
        case 'WATER_LOW': return '⚠️ Water Low';
        default: return '—';
    }
}

// ============== EDIT MODE ==============

function toggleEditMode() {
    isEditMode = !isEditMode;
    const btn = document.getElementById('btnEditMode');
    
    document.getElementById('viewMode').style.display = isEditMode ? 'none' : 'block';
    document.getElementById('editMode').style.display = isEditMode ? 'block' : 'none';
    
    btn.classList.toggle('active', isEditMode);
    btn.querySelector('.edit-label').textContent = isEditMode ? 'Done' : 'Edit';

    if (isEditMode) {
        renderEditMode();
    } else {
        renderProbeCards();
    }
}

function renderEditMode() {
    renderTempSensors();
    renderChannelList();
}

function renderTempSensors() {
    const container = document.getElementById('tempSensorsList');
    if (tempSensorsData.length === 0) {
        container.innerHTML = '<span style="color: #9ca3af; font-size: 0.85rem;">No temperature sensors detected on the MUX board.</span>';
        document.getElementById('tempSensorSubtitle').textContent = '0 sensors found';
        return;
    }

    document.getElementById('tempSensorSubtitle').textContent = `${tempSensorsData.length} sensor${tempSensorsData.length > 1 ? 's' : ''} found`;

    container.innerHTML = tempSensorsData.map(s => `
        <div class="ec-temp-sensor-item">
            <span class="ec-temp-sensor-index">#${s.index}</span>
            <span class="ec-temp-sensor-addr">${s.address}</span>
            <span class="ec-temp-sensor-temp ${s.valid ? '' : 'invalid'}">${s.valid ? s.temp_c.toFixed(1) + '°C' : 'N/A'}</span>
        </div>
    `).join('');
}

function renderChannelList() {
    const container = document.getElementById('channelList');

    container.innerHTML = channelsData.map(ch => {
        const color = PROBE_COLORS[ch.id % PROBE_COLORS.length];
        const tempOptions = buildTempSensorOptions(ch.temp_sensor_index);
        const liveEC = ch.ec_us_cm ? Math.round(ch.ec_us_cm) : '--';

        return `
        <div class="ec-channel-row ${ch.enabled ? 'ec-channel-row--enabled' : ''}" data-channel="${ch.id}">
            <div class="ec-channel-row__left">
                <div class="ec-channel-row__dot" style="background: ${color};"></div>
                <span class="ec-channel-row__id">CH${ch.id}</span>
                <label class="ec-toggle">
                    <input type="checkbox" ${ch.enabled ? 'checked' : ''} 
                           onchange="toggleChannel(${ch.id}, this.checked)">
                    <span class="ec-toggle__slider"></span>
                </label>
            </div>
            <div class="ec-channel-row__config ${ch.enabled ? '' : 'ec-channel-row__config--disabled'}">
                <div class="ec-channel-row__field">
                    <label>Name</label>
                    <input type="text" value="${escapeHtml(ch.name)}" maxlength="30" 
                           id="name_${ch.id}" class="ec-input"
                           onchange="updateChannelConfig(${ch.id})">
                </div>
                <div class="ec-channel-row__field ec-channel-row__field--small">
                    <label>K-Factor</label>
                    <div style="display: flex; gap: 0.25rem; align-items: center;">
                        <input type="number" value="${ch.k_factor.toFixed(2)}" step="0.01" min="0.1" max="10"
                               id="kf_${ch.id}" class="ec-input ec-input--narrow"
                               onchange="updateChannelConfig(${ch.id})">
                        <button class="ec-calibrate-btn" onclick="openCalibrate(${ch.id})" title="Quick Calibrate">🎯</button>
                    </div>
                </div>
                <div class="ec-channel-row__field ec-channel-row__field--small">
                    <label>Temp Sensor</label>
                    <select id="ts_${ch.id}" class="ec-select"
                            onchange="updateChannelConfig(${ch.id})">
                        ${tempOptions}
                    </select>
                </div>
                <div class="ec-channel-row__live">
                    <span class="ec-channel-row__live-val">${liveEC}</span>
                    <span class="ec-channel-row__live-unit">µS</span>
                </div>
            </div>
        </div>`;
    }).join('');
}

function buildTempSensorOptions(selectedIndex) {
    let html = `<option value="-1" ${selectedIndex === -1 ? 'selected' : ''}>None</option>`;
    tempSensorsData.forEach(s => {
        const label = `#${s.index} (${s.valid ? s.temp_c.toFixed(1) + '°C' : 'N/A'})`;
        html += `<option value="${s.index}" ${selectedIndex === s.index ? 'selected' : ''}>${label}</option>`;
    });
    return html;
}

function updateEditModeReadings() {
    channelsData.forEach(ch => {
        const liveEl = document.querySelector(`.ec-channel-row[data-channel="${ch.id}"] .ec-channel-row__live-val`);
        if (liveEl) {
            liveEl.textContent = ch.ec_us_cm ? Math.round(ch.ec_us_cm) : '--';
        }
    });
}

// ============== CHANNEL ACTIONS ==============

async function toggleChannel(channel, enabled) {
    try {
        await fetch('/api/ec/probe/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel, enabled })
        });
        // Update local data
        const ch = channelsData.find(c => c.id === channel);
        if (ch) ch.enabled = enabled;
        
        // Re-render the row state
        const row = document.querySelector(`.ec-channel-row[data-channel="${channel}"]`);
        if (row) {
            row.classList.toggle('ec-channel-row--enabled', enabled);
            const config = row.querySelector('.ec-channel-row__config');
            if (config) config.classList.toggle('ec-channel-row__config--disabled', !enabled);
        }
    } catch (e) {
        console.error("Toggle channel failed", e);
    }
}

async function updateChannelConfig(channel) {
    const name = document.getElementById(`name_${channel}`).value;
    const kFactor = parseFloat(document.getElementById(`kf_${channel}`).value);
    const tempSensorIndex = parseInt(document.getElementById(`ts_${channel}`).value);

    try {
        await fetch('/api/ec/probe/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                channel,
                name,
                k_factor: kFactor,
                temp_sensor_index: tempSensorIndex
            })
        });

        // Update local cache
        const ch = channelsData.find(c => c.id === channel);
        if (ch) {
            ch.name = name;
            ch.k_factor = kFactor;
            ch.temp_sensor_index = tempSensorIndex;
        }
    } catch (e) {
        console.error("Update channel config failed", e);
    }
}

// ============== MEASUREMENTS ==============

async function testAllProbes() {
    const btn = document.getElementById('btnTestAll');
    const originalHTML = btn.innerHTML;
    btn.innerHTML = '<span>⏳</span> Testing...';
    btn.disabled = true;

    try {
        const response = await fetch('/api/ec/measure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const data = await response.json();
        if (data.success) {
            updateUI(data);
            fetchHistory();
        } else {
            alert("Measurement failed: " + (data.error || 'Unknown error'));
        }
    } catch (e) {
        console.error("Test all failed", e);
        alert("Failed to reach server.");
    } finally {
        btn.innerHTML = originalHTML;
        btn.disabled = false;
    }
}

async function testSingleProbe(channel) {
    const btn = event.target;
    const originalText = btn.textContent;
    btn.textContent = '⏳...';
    btn.disabled = true;

    try {
        const response = await fetch('/api/ec/measure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel })
        });
        const data = await response.json();
        if (data.success) {
            updateUI(data);
            fetchHistory();
        }
    } catch (e) {
        console.error("Single probe test failed", e);
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

// ============== CALIBRATION ==============

function openCalibrate(channel) {
    calibrateChannel = channel;
    const ch = channelsData.find(c => c.id === channel);
    const name = ch ? ch.name : `Probe ${channel}`;

    document.getElementById('calibrateProbeLabel').textContent = `${name} (CH${channel})`;
    document.getElementById('calibrateECInput').value = '';
    document.getElementById('calibrateResult').style.display = 'none';
    document.getElementById('calibrateError').style.display = 'none';
    document.getElementById('calibrateModal').style.display = 'flex';
    document.getElementById('calibrateECInput').focus();
}

function closeCalibrate() {
    document.getElementById('calibrateModal').style.display = 'none';
    calibrateChannel = null;
}

async function submitCalibrate() {
    const refEC = parseFloat(document.getElementById('calibrateECInput').value);
    if (!refEC || refEC <= 0) {
        document.getElementById('calibrateError').textContent = 'Enter a valid EC value > 0';
        document.getElementById('calibrateError').style.display = 'block';
        return;
    }

    const btn = document.getElementById('btnCalibrateSubmit');
    btn.textContent = 'Calibrating...';
    btn.disabled = true;

    try {
        const response = await fetch('/api/ec/probe/calibrate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                channel: calibrateChannel,
                reference_ec: refEC
            })
        });
        const data = await response.json();

        if (data.success) {
            document.getElementById('calibrateError').style.display = 'none';
            document.getElementById('calibrateResultText').textContent = 
                `✅ K-Factor updated: ${data.old_k_factor.toFixed(3)} → ${data.new_k_factor.toFixed(3)} | Calibrated EC: ${Math.round(data.calibrated_ec)} µS/cm`;
            document.getElementById('calibrateResult').style.display = 'block';

            // Update local data
            const ch = channelsData.find(c => c.id === calibrateChannel);
            if (ch) ch.k_factor = data.new_k_factor;

            // Update K-factor input in edit mode
            const kfInput = document.getElementById(`kf_${calibrateChannel}`);
            if (kfInput) kfInput.value = data.new_k_factor.toFixed(2);

            // Refresh status
            setTimeout(() => {
                fetchStatus();
                closeCalibrate();
            }, 2000);
        } else {
            document.getElementById('calibrateError').textContent = data.error || 'Calibration failed';
            document.getElementById('calibrateError').style.display = 'block';
        }
    } catch (e) {
        document.getElementById('calibrateError').textContent = 'Failed to reach server';
        document.getElementById('calibrateError').style.display = 'block';
    } finally {
        btn.textContent = 'Calibrate';
        btn.disabled = false;
    }
}

// ============== CHART (MULTI-LINE) ==============

function updateChart(history) {
    const ctx = document.getElementById('ecChart').getContext('2d');

    // Group by channel
    const channelGroups = {};
    history.forEach(item => {
        const chId = item.channel_id !== undefined ? item.channel_id : 0;
        if (!channelGroups[chId]) {
            channelGroups[chId] = {
                name: item.channel_name || `Probe ${chId}`,
                data: []
            };
        }
        channelGroups[chId].data.push({
            x: new Date(item.timestamp),
            y: Math.max(0, item.ec_value)
        });
    });

    const now = new Date();
    const past = new Date(now.getTime() - (currentHistoryHours * 60 * 60 * 1000));

    // Build datasets
    const datasets = Object.keys(channelGroups).map(chId => {
        const group = channelGroups[chId];
        const color = PROBE_COLORS[parseInt(chId) % PROBE_COLORS.length];
        return {
            label: group.name,
            data: group.data,
            borderColor: color,
            backgroundColor: color + '1A',
            borderWidth: 2,
            pointRadius: 0,
            pointHitRadius: 10,
            fill: false,
            tension: 0.2
        };
    });

    // Dynamic Y axis
    const allValues = history.map(d => d.ec_value).filter(v => v > 0);
    let yMin = 0, yMax = 2000;
    if (allValues.length > 0) {
        yMin = Math.max(0, Math.min(...allValues) - 200);
        yMax = Math.max(...allValues) + 200;
    }

    if (ecChart) {
        ecChart.data.datasets = datasets;
        ecChart.options.scales.x.min = past;
        ecChart.options.scales.x.max = now;
        ecChart.options.scales.y.min = yMin;
        ecChart.options.scales.y.max = yMax;
        ecChart.update();
    } else {
        ecChart = new Chart(ctx, {
            type: 'line',
            data: { datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    intersect: false,
                    mode: 'index',
                },
                scales: {
                    x: {
                        type: 'time',
                        min: past,
                        max: now,
                        time: { tooltipFormat: 'MMM d, h:mm a' },
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        ticks: { color: '#9ca3af' }
                    },
                    y: {
                        min: yMin,
                        max: yMax,
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        ticks: { color: '#9ca3af' }
                    }
                },
                plugins: {
                    legend: {
                        display: datasets.length > 1,
                        labels: {
                            color: '#d1d5db',
                            usePointStyle: true,
                            pointStyle: 'circle',
                            padding: 16
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(17, 24, 39, 0.9)',
                        titleColor: '#f3f4f6',
                        bodyColor: '#d1d5db',
                        borderColor: 'rgba(255,255,255,0.1)',
                        borderWidth: 1,
                        padding: 10
                    }
                }
            }
        });
    }
}

// ============== SETTINGS ==============

function showPinModal() {
    document.getElementById('pinModal').style.display = 'flex';
    document.getElementById('pinInput').value = '';
    document.getElementById('pinInput').focus();
    document.getElementById('pinError').style.display = 'none';
}

function closePinModal() {
    document.getElementById('pinModal').style.display = 'none';
}

async function submitSettings() {
    const pin = document.getElementById('pinInput').value;
    const newInterval = parseInt(document.getElementById('newIntervalInput').value);

    if (!pin || pin.length < 4) {
        document.getElementById('pinError').textContent = 'Enter 4-digit PIN';
        document.getElementById('pinError').style.display = 'block';
        return;
    }

    if (isNaN(newInterval) || newInterval < 1) {
        alert("Enter a valid interval");
        return;
    }

    try {
        const iRes = await fetch('/api/ec/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ interval: newInterval, code: pin })
        });

        if (iRes.status === 403) {
            document.getElementById('pinError').textContent = 'Invalid PIN';
            document.getElementById('pinError').style.display = 'block';
            return;
        }

        if (iRes.ok) {
            closePinModal();
        } else {
            alert("Failed to save settings");
        }
    } catch (e) {
        console.error(e);
        alert("Failed to communicate with server");
    }
}

// ============== HELPERS ==============

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============== INIT ==============

document.addEventListener('DOMContentLoaded', () => {
    fetchStatus();
    fetchHistory();
    fetchSettings();

    setInterval(fetchStatus, 5000);
    setInterval(() => fetchHistory(), 5 * 60 * 1000);

    // Period buttons
    document.querySelectorAll('.period-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            const hours = parseInt(e.target.dataset.hours);
            document.getElementById('graphSubtitle').textContent = `Last ${e.target.textContent}`;
            fetchHistory(hours);
        });
    });

    // Edit mode
    document.getElementById('btnEditMode').addEventListener('click', toggleEditMode);

    // Test All
    document.getElementById('btnTestAll').addEventListener('click', testAllProbes);

    // Settings
    document.getElementById('btnSaveSettings').addEventListener('click', showPinModal);
    document.getElementById('btnPinCancel').addEventListener('click', closePinModal);
    document.getElementById('btnPinSubmit').addEventListener('click', submitSettings);

    // Calibrate
    document.getElementById('btnCalibrateCancel').addEventListener('click', closeCalibrate);
    document.getElementById('btnCalibrateSubmit').addEventListener('click', submitCalibrate);
});


// ============== TEMPERATURE SENSOR FUNCTIONS ==============

/**
 * Update temperature card with sensor readings
 */
function updateTempCard(data, heaterData) {
    // Store heater status for display logic
    if (heaterData) window.heaterStatus = heaterData;

    const statusBadge = document.querySelector('#tempStatus .badge');
    const errorEl = document.getElementById('tempError');
    const metricsEl = document.getElementById('tempSensorMetrics');
    const card = document.getElementById('tempCard');

    if (!card) return;

    card.classList.remove('loading');

    if (!data || !data.available) {
        statusBadge.className = 'badge offline';
        statusBadge.textContent = 'Offline';
        errorEl.textContent = data?.error || 'ESP32 unavailable';
        errorEl.style.display = 'block';
        metricsEl.innerHTML = '<p style="text-align: center; color: var(--text-muted); padding: 1rem;">No sensors detected</p>';
        return;
    }

    errorEl.style.display = 'none';

    const sensors = data.sensors || [];
    const sensorCount = data.sensor_count || 0;
    const heaterOn = window.heaterStatus?.is_on || false;

    if (sensorCount === 0) {
        statusBadge.className = 'badge standby';
        statusBadge.textContent = 'No Sensors';
        metricsEl.innerHTML = '<p style="text-align: center; color: var(--text-muted); padding: 1rem;">Configure sensors in settings</p>';
        return;
    }

    statusBadge.className = 'badge online';
    // Show heater status if enabled
    const heaterIcon = heaterOn ? ' 🔥' : '';
    statusBadge.textContent = `${sensorCount} Sensor${sensorCount > 1 ? 's' : ''}${heaterIcon}`;

    // Display sensors
    let html = '';
    sensors.forEach(sensor => {
        const tempValue = sensor.valid ? `${sensor.temp_c.toFixed(1)}°C` : '—';
        const tempClass = sensor.valid ? 'on' : 'off';

        html += `
            <div class="metric">
                <span class="metric-label">${sensor.name || 'Unknown'}</span>
                <span class="metric-value ${tempClass}">${tempValue}</span>
            </div>
        `;
    });

    metricsEl.innerHTML = html;
}

/**
 * Initialize temperature sensor detection
 */
function initTempSettings() {
    const btnDetectSensors = document.getElementById('btnDetectSensors');

    // Function to load sensors
    const loadSensors = async () => {
        const sensorList = document.getElementById('sensorList');
        const tempSensorCount = document.getElementById('tempSensorCount');

        if (btnDetectSensors) {
            btnDetectSensors.textContent = '🔍 Detecting...';
            btnDetectSensors.disabled = true;
        }

        try {
            // This now returns cached status with names if available (fast)
            const response = await fetch('/api/temp/detect', {
                method: 'POST'
            });
            const data = await response.json();

            if (data.success && data.sensors) {
                const count = data.sensors.length;
                if (tempSensorCount) tempSensorCount.textContent = count;

                // Render sensor list
                let html = '';
                data.sensors.forEach(sensor => {
                    html += `
                        <div class="sensor-row" style="margin-top: 0.75rem; padding: 0.75rem; background: var(--card-bg); border-radius: 8px;">
                            <div style="display: flex; align-items: center; gap: 0.5rem;">
                                <span style="font-family: monospace; font-size: 0.8rem; color: var(--text-muted);">${sensor.address}</span>
                            </div>
                            <input type="text" 
                                   class="sensor-name-input" 
                                   data-address="${sensor.address}"
                                   value="${sensor.name || ''}" 
                                   placeholder="Sensor Name"
                                   style="width: 100%; margin-top: 0.5rem; padding: 0.5rem; background: var(--bg-dark); border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-color);">
                        </div>
                    `;
                });

                if (sensorList) {
                    sensorList.innerHTML = html;

                    // Add event listeners for name inputs
                    const nameInputs = sensorList.querySelectorAll('.sensor-name-input');
                    nameInputs.forEach(input => {
                        input.addEventListener('change', async () => {
                            const address = input.dataset.address;
                            const name = input.value.trim();

                            if (name) {
                                try {
                                    await fetch('/api/temp/sensor/name', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ address, name })
                                    });
                                    console.log(`[TEMP] Saved name for ${address}: ${name}`);
                                } catch (e) {
                                    console.error('[TEMP] Failed to save sensor name:', e);
                                }
                            }
                        });
                    });
                }
            } else {
                if (sensorList) sensorList.innerHTML = '<p style="color: var(--text-muted); margin-top: 0.75rem;">No sensors detected. Check wiring and ESP32 connection.</p>';
                if (tempSensorCount) tempSensorCount.textContent = '0';
            }
        } catch (e) {
            console.error('[TEMP] Detection failed:', e);
            if (sensorList) sensorList.innerHTML = '<p style="color: var(--accent-red); margin-top: 0.75rem;">Detection failed. Is ESP32 temperature monitor online?</p>';
        }

        if (btnDetectSensors) {
            btnDetectSensors.textContent = '🔍 Detect Sensors';
            btnDetectSensors.disabled = false;
        }
    };

    if (btnDetectSensors) {
        btnDetectSensors.onclick = loadSensors;
    }

    // Auto-load on init
    loadSensors();
}

// Initialize temperature settings when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    initTempSettings();
});


// ============== TEMPERATURE SENSOR FUNCTIONS ==============

/**
 * Update temperature card with sensor readings
 */
function updateTempCard(data) {
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

    if (sensorCount === 0) {
        statusBadge.className = 'badge standby';
        statusBadge.textContent = 'No Sensors';
        metricsEl.innerHTML = '<p style="text-align: center; color: var(--text-muted); padding: 1rem;">Configure sensors in settings</p>';
        return;
    }

    statusBadge.className = 'badge online';
    statusBadge.textContent = `${sensorCount} Sensor${sensorCount > 1 ? 's' : ''}`;

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

async function saveTempPin() {
    const pin = parseInt(document.getElementById('temp-onewire-pin').value);

    if (pin < 0 || pin > 39) {
        alert('Invalid pin number. Must be between 0 and 39.');
        return;
    }

    const code = prompt('Enter authentication code:');
    if (!code) return;

    try {
        const response = await fetch('/api/temp/pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin, code })
        });

        const result = await response.json();

        if (result.success) {
            alert('OneWire pin saved! Please restart ESP32 for changes to take effect.');
        } else {
            alert('Error: ' + (result.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('[TEMP] Error saving pin:', error);
        alert('Failed to save pin configuration');
    }
}

/**
 * Initialize temperature sensor detection
 */
function initTempSettings() {
    const btnDetectSensors = document.getElementById('btnDetectSensors');
    const sensorList = document.getElementById('sensorList');
    const tempSensorCount = document.getElementById('tempSensorCount');
    const saveTempPinBtn = document.getElementById('save-temp-pin-btn');

    // Wire up save pin button
    if (saveTempPinBtn) {
        saveTempPinBtn.addEventListener('click', saveTempPin);
    }

    if (btnDetectSensors) {
        btnDetectSensors.onclick = async () => {
            btnDetectSensors.textContent = '🔍 Detecting...';
            btnDetectSensors.disabled = true;

            try {
                const response = await fetch('/api/temp/detect', {
                    method: 'POST'
                });
                const data = await response.json();

                if (data.success && data.sensors) {
                    const count = data.sensors.length;
                    tempSensorCount.textContent = count;

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
                                       value="${sensor.name}" 
                                       placeholder="Sensor Name"
                                       style="width: 100%; margin-top: 0.5rem; padding: 0.5rem; background: var(--bg-dark); border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-color);">
                            </div>
                        `;
                    });

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
                } else {
                    sensorList.innerHTML = '<p style="color: var(--text-muted); margin-top: 0.75rem;">No sensors detected. Check wiring and ESP32 connection.</p>';
                    tempSensorCount.textContent = '0';
                }
            } catch (e) {
                console.error('[TEMP] Detection failed:', e);
                sensorList.innerHTML = '<p style="color: var(--accent-red); margin-top: 0.75rem;">Detection failed. Is ESP32 temperature monitor online?</p>';
            }

            btnDetectSensors.textContent = '🔍 Detect Sensors';
            btnDetectSensors.disabled = false;
        };
    }
}

// Initialize temperature settings when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    initTempSettings();
});

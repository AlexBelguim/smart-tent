/**
 * Smart Tent Dashboard - EC & Water
 */

const FALLBACK_REFRESH_INTERVAL = 3000;
let ecChart = null;

async function fetchStatus() {
    try {
        const response = await fetch('/api/ec');
        const data = await response.json();
        updateCard(data);
    } catch (e) {
        console.error("Failed to fetch EC status", e);
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

let currentHistoryHours = 168;

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

function updateCard(data) {
    const errorEl = document.getElementById('ecError');
    const badgeEl = document.getElementById('statusBadge');
    
    if (!data.available) {
        errorEl.textContent = data.error || 'Device offline';
        errorEl.style.display = 'block';
        badgeEl.className = 'badge offline';
        badgeEl.textContent = 'Offline';
        return;
    }

    errorEl.style.display = 'none';
    badgeEl.className = 'badge online';
    badgeEl.textContent = 'Online';

    // Update Values
    document.getElementById('ecValue').textContent = data.ec_us_cm ? Math.round(data.ec_us_cm) : '--';
    document.getElementById('waterValue').textContent = data.water_empty ? 'LOW' : 'OK';
    document.getElementById('adcValue').textContent = data.raw_adc !== undefined ? data.raw_adc : '--';
    document.getElementById('kfactorValue').textContent = data.k_factor !== undefined ? data.k_factor.toFixed(2) : '--';

    // Status colors
    if (data.water_empty) {
        document.getElementById('waterValue').style.color = 'var(--accent-amber)';
        document.getElementById('waterValue').style.fontWeight = 'bold';
    } else {
        document.getElementById('waterValue').style.color = 'inherit';
    }
}

async function forceMeasurement() {
    const btn = document.getElementById('btnTestNow');
    const originalText = btn.textContent;
    btn.textContent = 'Testing (10s)...';
    btn.disabled = true;
    
    try {
        const response = await fetch('/api/ec/measure', { method: 'POST' });
        const data = await response.json();
        if (data.success) {
            updateCard(data);
            fetchHistory(); // refresh the graph with the new point
        } else {
            console.error("Measurement failed:", data.error);
            alert("Measurement failed: " + data.error);
        }
    } catch (e) {
        console.error("Measurement request failed", e);
        alert("Failed to reach server for measurement.");
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

function updateChart(history) {
    const ctx = document.getElementById('ecChart').getContext('2d');
    
    const chartData = history.map(item => ({
        x: new Date(item.timestamp),
        y: Math.max(0, item.ec_value) // Filter negative/invalid if any
    }));

    const now = new Date();
    const past = new Date(now.getTime() - (currentHistoryHours * 60 * 60 * 1000));

    if (ecChart) {
        ecChart.data.datasets[0].data = chartData;
        ecChart.options.scales.x.min = past;
        ecChart.options.scales.x.max = now;
        ecChart.update();
    } else {
        ecChart = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [{
                    label: 'EC (µS/cm)',
                    data: chartData,
                    borderColor: '#4ade80',
                    backgroundColor: 'rgba(74, 222, 128, 0.1)',
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHitRadius: 10,
                    fill: true,
                    tension: 0.2
                }]
            },
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
                        time: {
                            tooltipFormat: 'MMM d, h:mm a'
                        },
                        grid: {
                            color: 'rgba(255, 255, 255, 0.05)'
                        },
                        ticks: {
                            color: '#9ca3af'
                        }
                    },
                    y: {
                        beginAtZero: true,
                        suggestedMax: 2000,
                        grid: {
                            color: 'rgba(255, 255, 255, 0.05)'
                        },
                        ticks: {
                            color: '#9ca3af'
                        }
                    }
                },
                plugins: {
                    legend: {
                        display: false
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

// PIN Modal functions
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
    const newKFactor = parseFloat(document.getElementById('newKFactorInput').value);
    const newInterval = parseInt(document.getElementById('newIntervalInput').value);
    
    if (!pin || pin.length < 4) {
        document.getElementById('pinError').textContent = 'Enter 4-digit PIN';
        document.getElementById('pinError').style.display = 'block';
        return;
    }
    
    if (isNaN(newKFactor) || isNaN(newInterval) || newInterval < 1) {
        alert("Enter a valid K-Factor and Interval");
        return;
    }

    try {
        // Save K-Factor to ESP
        let kFactorSuccess = true;
        const kRes = await fetch('/api/ec/kfactor', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kfactor: newKFactor, code: pin })
        });
        
        if (kRes.status === 403) {
            document.getElementById('pinError').textContent = 'Invalid PIN';
            document.getElementById('pinError').style.display = 'block';
            return;
        }
        if (!kRes.ok) kFactorSuccess = false;

        // Save Interval to Backend
        let intervalSuccess = true;
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
        if (!iRes.ok) intervalSuccess = false;


        if (kFactorSuccess && intervalSuccess) {
            closePinModal();
            fetchStatus();
        } else {
            alert("Error saving one or more settings!");
        }
    } catch (e) {
        console.error(e);
        alert("Failed to communicate with server");
    }
}

document.addEventListener('DOMContentLoaded', () => {
    fetchStatus();
    fetchHistory();
    fetchSettings();
    
    // Auto refresh status every 5 seconds
    setInterval(fetchStatus, 5000);
    // Refresh history graph every 5 minutes
    setInterval(() => fetchHistory(), 5 * 60 * 1000);
    
    // Period buttons
    document.querySelectorAll('.period-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            // Update active state
            document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            
            // Fetch new data
            const hours = parseInt(e.target.dataset.hours);
            document.getElementById('graphSubtitle').textContent = `Last ${e.target.textContent}`;
            fetchHistory(hours);
        });
    });

    // UI Events
    document.getElementById('btnChangeSettings').addEventListener('click', showPinModal);
    document.getElementById('btnPinCancel').addEventListener('click', closePinModal);
    document.getElementById('btnPinSubmit').addEventListener('click', submitSettings);
    document.getElementById('btnTestNow').addEventListener('click', forceMeasurement);
});

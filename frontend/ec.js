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

async function fetchHistory() {
    try {
        // Fetch last 7 days (168 hours)
        const response = await fetch('/api/ec/history?hours=168');
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

function updateChart(history) {
    const ctx = document.getElementById('ecChart').getContext('2d');
    
    const chartData = history.map(item => ({
        x: new Date(item.timestamp),
        y: Math.max(0, item.ec_value) // Filter negative/invalid if any
    }));

    if (ecChart) {
        ecChart.data.datasets[0].data = chartData;
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

async function submitKFactor() {
    const pin = document.getElementById('pinInput').value;
    const newKFactor = parseFloat(document.getElementById('newKFactorInput').value);
    
    if (!pin || pin.length < 4) {
        document.getElementById('pinError').textContent = 'Enter 4-digit PIN';
        document.getElementById('pinError').style.display = 'block';
        return;
    }
    
    if (isNaN(newKFactor)) {
        alert("Enter a valid K-Factor");
        return;
    }

    try {
        const response = await fetch('/api/ec/kfactor', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                kfactor: newKFactor,
                code: pin
            })
        });

        if (response.status === 403) {
            document.getElementById('pinError').textContent = 'Invalid PIN';
            document.getElementById('pinError').style.display = 'block';
            return;
        }

        if (response.ok) {
            closePinModal();
            fetchStatus(); // Refresh to see the new K-Factor
        } else {
            const data = await response.json();
            alert("Error: " + data.error);
        }
    } catch (e) {
        console.error(e);
        alert("Failed to communicate with server");
    }
}

document.addEventListener('DOMContentLoaded', () => {
    fetchStatus();
    fetchHistory();
    
    // Auto refresh status every 5 seconds
    setInterval(fetchStatus, 5000);
    // Refresh history graph every 5 minutes
    setInterval(fetchHistory, 5 * 60 * 1000);
    
    // UI Events
    document.getElementById('btnChangeKFactor').addEventListener('click', showPinModal);
    document.getElementById('btnPinCancel').addEventListener('click', closePinModal);
    document.getElementById('btnPinSubmit').addEventListener('click', submitKFactor);
});

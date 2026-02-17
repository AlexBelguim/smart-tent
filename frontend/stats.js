/**
 * Smart Tent Stats Page — Charts & Setup Notes
 */

let energyChart = null;
let costChart = null;
let humidityChart = null;
let tempChart = null;
let currentPeriod = 30;
let setupNotes = [];

// Chart.js defaults for dark theme
Chart.defaults.color = '#6b7280';
Chart.defaults.borderColor = 'rgba(255, 255, 255, 0.06)';
Chart.defaults.font.family = "'Inter', sans-serif";

/**
 * Fetch stats data from the API
 */
async function fetchStats(period) {
    try {
        const response = await fetch(`/api/stats?period=${period}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        console.error('Failed to fetch stats:', error);
        return null;
    }
}

/**
 * Build annotation config from setup notes for charts
 */
function buildNoteAnnotations(notes) {
    const annotations = {};
    notes.forEach((note, i) => {
        annotations[`note_${i}`] = {
            type: 'line',
            xMin: note.date,
            xMax: note.date,
            borderColor: 'rgba(245, 158, 11, 0.6)',
            borderWidth: 2,
            borderDash: [4, 4],
            label: {
                display: true,
                content: note.text,
                position: 'start',
                backgroundColor: 'rgba(245, 158, 11, 0.15)',
                color: '#f59e0b',
                font: { size: 10, weight: '500' },
                padding: { top: 2, bottom: 2, left: 4, right: 4 },
                borderRadius: 4
            }
        };
    });
    return annotations;
}

/**
 * Create or update the Temperature History chart
 */
function renderTempChart(history, currentSensors, notes, energyData = []) {
    const ctx = document.getElementById('tempChart');
    if (!ctx) return;

    // Check toggle state
    const showOverlay = document.getElementById('toggleEnergyOverlay')?.checked;

    // Group data by address
    const sensors = {};
    history.forEach(r => {
        if (!sensors[r.address]) sensors[r.address] = [];
        sensors[r.address].push({
            x: r.timestamp,
            y: r.temp_c
        });
    });

    // Create datasets
    const datasets = Object.keys(sensors).map((addr, i) => {
        // Find name: check currentSensors first to handle renaming
        const current = (currentSensors || []).find(s => s.address === addr);
        // Fallback to name in history record if available, else address
        const historyName = history.find(r => r.address === addr)?.name;
        const name = current ? current.name : (historyName || addr || 'Unknown');

        // Generate distinct color based on index
        const hue = (i * 137.5) % 360;
        const color = `hsl(${hue}, 70%, 60%)`;

        return {
            label: name,
            data: sensors[addr],
            borderColor: color,
            backgroundColor: color, // for tooltip point
            borderWidth: 2,
            tension: 0.4,
            pointRadius: 0,
            pointHoverRadius: 4
        };
    });

    // Add Energy Overlay Dataset
    if (energyData && energyData.length > 0) {
        datasets.push({
            label: 'Energy (kWh)',
            data: energyData.map(d => ({ x: d.date, y: d.kwh })),
            type: 'line',
            yAxisID: 'y1',
            backgroundColor: 'rgba(168, 85, 247, 0.1)',
            borderColor: 'rgba(168, 85, 247, 0.8)',
            borderWidth: 2,
            borderDash: [4, 4],
            fill: true,
            tension: 0.4,
            pointRadius: 3,
            hidden: !showOverlay
        });
    }

    const config = {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            scales: {
                x: {
                    type: 'time',
                    time: {
                        unit: 'day',
                        displayFormats: { day: 'MMM d' }
                    },
                    ticks: { maxTicksLimit: 8 },
                    grid: { display: false }
                },
                y: {
                    beginAtZero: false,
                    title: { display: true, text: '°C', color: '#6b7280' },
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    position: 'left'
                },
                y1: {
                    display: showOverlay, // Only show axis if overlay is on
                    beginAtZero: true,
                    position: 'right',
                    title: { display: true, text: 'kWh', color: '#a855f7' },
                    grid: { drawOnChartArea: false }, // Prevent grid clash
                    ticks: { color: '#a855f7' }
                }
            },
            plugins: {
                legend: {
                    display: true,
                    labels: { color: '#9ca3af', boxWidth: 12 }
                },
                annotation: { annotations: buildNoteAnnotations(notes) },
                tooltip: {
                    callbacks: {
                        title: function (items) {
                            const d = new Date(items[0].parsed.x);
                            return d.toLocaleString(undefined, {
                                month: 'short', day: 'numeric',
                                hour: '2-digit', minute: '2-digit'
                            });
                        }
                    }
                }
            }
        }
    };

    if (tempChart) tempChart.destroy();
    tempChart = new Chart(ctx, config);
}

/**
 * Create or update the Energy chart
 */
function renderEnergyChart(data, notes) {
    const ctx = document.getElementById('energyChart');
    if (!ctx) return;

    const labels = data.map(d => d.date);
    const values = data.map(d => d.kwh);

    const chartData = {
        labels,
        datasets: [{
            label: 'Energy (kWh)',
            data: values,
            borderColor: '#a855f7',
            backgroundColor: 'rgba(168, 85, 247, 0.1)',
            borderWidth: 2,
            fill: true,
            tension: 0.3,
            pointRadius: labels.length > 60 ? 0 : 3,
            pointHoverRadius: 5,
            pointBackgroundColor: '#a855f7'
        }]
    };

    const config = {
        type: 'line',
        data: chartData,
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            scales: {
                x: {
                    ticks: {
                        maxTicksLimit: 10,
                        callback: function (val) {
                            const label = this.getLabelForValue(val);
                            const d = new Date(label);
                            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                        }
                    },
                    grid: { display: false }
                },
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'kWh', color: '#6b7280' },
                    grid: { color: 'rgba(255,255,255,0.04)' }
                }
            },
            plugins: {
                legend: { display: false },
                annotation: { annotations: buildNoteAnnotations(notes) },
                tooltip: {
                    callbacks: {
                        title: function (items) {
                            const d = new Date(items[0].label);
                            return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
                        },
                        label: function (item) {
                            return `${item.parsed.y.toFixed(3)} kWh`;
                        }
                    }
                }
            }
        }
    };

    if (energyChart) {
        energyChart.destroy();
    }
    energyChart = new Chart(ctx, config);
}

/**
 * Create or update the Monthly Cost chart
 */
function renderCostChart(data, currency, notes) {
    const ctx = document.getElementById('costChart');
    if (!ctx) return;

    const labels = data.map(d => d.month);
    const values = data.map(d => d.cost);

    // Update subtitle
    const currLabel = document.getElementById('costCurrency');
    if (currLabel) currLabel.textContent = `${currency} per month`;

    const chartData = {
        labels,
        datasets: [{
            label: `Cost (${currency})`,
            data: values,
            backgroundColor: data.map((_, i) =>
                i === data.length - 1 ? 'rgba(168, 85, 247, 0.7)' : 'rgba(168, 85, 247, 0.4)'
            ),
            borderColor: '#a855f7',
            borderWidth: 1,
            borderRadius: 6
        }]
    };

    const config = {
        type: 'bar',
        data: chartData,
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    ticks: {
                        callback: function (val) {
                            const label = this.getLabelForValue(val);
                            const parts = label.split('-');
                            const d = new Date(parts[0], parts[1] - 1);
                            return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
                        }
                    },
                    grid: { display: false }
                },
                y: {
                    beginAtZero: true,
                    title: { display: true, text: currency, color: '#6b7280' },
                    grid: { color: 'rgba(255,255,255,0.04)' }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: function (items) {
                            const label = items[0].label;
                            const parts = label.split('-');
                            const d = new Date(parts[0], parts[1] - 1);
                            return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
                        },
                        label: function (item) {
                            return `${currency} ${item.parsed.y.toFixed(2)}`;
                        }
                    }
                }
            }
        }
    };

    if (costChart) {
        costChart.destroy();
    }
    costChart = new Chart(ctx, config);
}

/**
 * Create or update the Humidity Runtime chart
 */
function renderHumidityChart(data, notes) {
    const ctx = document.getElementById('humidityChart');
    if (!ctx) return;

    const labels = data.map(d => d.date);
    const values = data.map(d => d.percent);

    const chartData = {
        labels,
        datasets: [{
            label: 'Runtime (%)',
            data: values,
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            borderWidth: 2,
            fill: true,
            tension: 0.3,
            pointRadius: labels.length > 60 ? 0 : 3,
            pointHoverRadius: 5,
            pointBackgroundColor: '#3b82f6'
        }]
    };

    const config = {
        type: 'line',
        data: chartData,
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            scales: {
                x: {
                    ticks: {
                        maxTicksLimit: 10,
                        callback: function (val) {
                            const label = this.getLabelForValue(val);
                            const d = new Date(label);
                            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                        }
                    },
                    grid: { display: false }
                },
                y: {
                    beginAtZero: true,
                    max: 100,
                    title: { display: true, text: '%', color: '#6b7280' },
                    grid: { color: 'rgba(255,255,255,0.04)' }
                }
            },
            plugins: {
                legend: { display: false },
                annotation: { annotations: buildNoteAnnotations(notes) },
                tooltip: {
                    callbacks: {
                        title: function (items) {
                            const d = new Date(items[0].label);
                            return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
                        },
                        label: function (item) {
                            return `${item.parsed.y.toFixed(1)}% on time`;
                        }
                    }
                }
            }
        }
    };

    if (humidityChart) {
        humidityChart.destroy();
    }
    humidityChart = new Chart(ctx, config);
}

/**
 * Render setup notes list
 */
function renderNotes(notes) {
    const list = document.getElementById('notesList');
    if (!list) return;

    setupNotes = notes;

    if (!notes || notes.length === 0) {
        list.innerHTML = '<p style="text-align: center; color: var(--text-muted); font-size: 0.85rem;">No setup changes recorded yet.</p>';
        return;
    }

    list.innerHTML = notes.map(note => `
        <div class="note-item" data-id="${note.id}">
            <span class="note-date">${new Date(note.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            <span class="note-text-display">${escapeHtml(note.text)}</span>
            <button class="note-delete" onclick="deleteNote(${note.id})" title="Delete">✕</button>
        </div>
    `).join('');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Add a new setup note
 */
async function addNoteHandler() {
    const dateEl = document.getElementById('noteDate');
    const textEl = document.getElementById('noteText');

    const dateVal = dateEl?.value;
    const textVal = textEl?.value?.trim();

    if (!textVal) {
        textEl?.focus();
        return;
    }

    try {
        const response = await fetch('/api/notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                date: dateVal || new Date().toISOString().split('T')[0],
                text: textVal
            })
        });

        if (response.ok) {
            textEl.value = '';
            // Refresh everything
            loadStats(currentPeriod);
        }
    } catch (error) {
        console.error('Failed to add note:', error);
    }
}

/**
 * Delete a setup note
 */
async function deleteNote(noteId) {
    try {
        const response = await fetch(`/api/notes/${noteId}`, { method: 'DELETE' });
        if (response.ok) {
            loadStats(currentPeriod);
        }
    } catch (error) {
        console.error('Failed to delete note:', error);
    }
}

/**
 * Load and render all stats
 */
async function loadStats(period) {
    currentPeriod = period;

    const data = await fetchStats(period);
    if (!data) return;

    const notes = data.notes || [];

    // Temperature chart
    if (data.temp_history && data.temp_history.length > 0) {
        // We need chart.js date adapter for time scale, but let's try basic labels if adapter missing
        // Actually for multi-line time series we really need the adapter or manual parsing
        // For simplicity let's stick to standard line chart logic if we can map to common labels? 
        // But sensors have different timestamps. Scatter plot with 'type: time' is best.
        // Assuming user has date adapter or we include it? 
        // The HTML includes chart.umd.min.js which bundles dependencies? Usually not date-fns adapter.
        // Let's use simple labels logic if we group by nearest hour?
        // No, let's just pass X as ISO string, Chart.js 4 might handle it or we use index mode with unified labels?
        // Let's try to enable date adapter in HTML or use primitive index.
        renderTempChart(data.temp_history, data.temp_sensors, notes, data.energy_daily);
    }

    // Energy chart (daily)
    if (data.energy_daily && data.energy_daily.length > 0) {
        renderEnergyChart(data.energy_daily, notes);
    }

    // Cost chart (monthly)
    if (data.energy_monthly && data.energy_monthly.length > 0) {
        renderCostChart(data.energy_monthly, data.currency || '€', notes);
    }

    // Humidity runtime
    if (data.humidity_runtime && data.humidity_runtime.length > 0) {
        renderHumidityChart(data.humidity_runtime, notes);
    }

    // Notes list
    renderNotes(notes);
}

/**
 * Initialize
 */
document.addEventListener('DOMContentLoaded', () => {
    // Set default date for note input to today
    const dateInput = document.getElementById('noteDate');
    if (dateInput) {
        dateInput.value = new Date().toISOString().split('T')[0];
    }

    // Period selector buttons
    document.querySelectorAll('.period-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            loadStats(parseInt(btn.dataset.period));
        });
    });

    // Add note button
    const btnAdd = document.getElementById('btnAddNote');
    if (btnAdd) {
        btnAdd.addEventListener('click', addNoteHandler);
    }

    // Enter key on note text input
    const noteText = document.getElementById('noteText');
    if (noteText) {
        noteText.addEventListener('keydown', e => {
            if (e.key === 'Enter') addNoteHandler();
        });
    }

    // Toggle Energy Overlay
    const toggleOverlay = document.getElementById('toggleEnergyOverlay');
    if (toggleOverlay) {
        toggleOverlay.addEventListener('change', () => {
            loadStats(currentPeriod);
        });
    }

    // Initial load
    loadStats(currentPeriod);
});

/**
 * Smart Tent Dashboard - Frontend Application with Socket.IO
 */

// Socket.IO connection
let socket = null;
const FALLBACK_REFRESH_INTERVAL = 10000; // Fallback if Socket.IO fails

/**
 * Format seconds into human-readable duration
 */
function formatDuration(seconds) {
    if (!seconds || seconds < 0) return '--';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 24) {
        const days = Math.floor(hours / 24);
        const remainingHours = hours % 24;
        return `${days}d ${remainingHours}h`;
    }

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }

    if (minutes > 0) {
        return `${minutes}m ${secs}s`;
    }

    return `${secs}s`;
}

/**
 * Format minutes into human-readable duration
 */
function formatMinutes(minutes) {
    if (!minutes || minutes < 0) return '--';

    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;

    if (hours > 24) {
        const days = Math.floor(hours / 24);
        const remainingHours = hours % 24;
        return `${days}d ${remainingHours}h`;
    }

    if (hours > 0) {
        return `${hours}h ${mins}m`;
    }

    return `${mins}m`;
}

/**
 * Format energy values with appropriate units
 */
function formatEnergy(wh) {
    if (!wh && wh !== 0) return '--';

    if (wh >= 1000) {
        return `${(wh / 1000).toFixed(2)} kWh`;
    }

    return `${wh} Wh`;
}

/**
 * Update the last update timestamp
 */
function updateTimestamp(timestamp) {
    const el = document.getElementById('lastUpdate');
    if (timestamp) {
        const date = new Date(timestamp);
        el.textContent = date.toLocaleTimeString();
    } else {
        el.textContent = new Date().toLocaleTimeString();
    }
}

/**
 * Update connection status indicator
 */
function updateConnectionStatus(connected) {
    const pulse = document.querySelector('.pulse');
    const statusText = document.querySelector('.status-text');

    if (connected) {
        pulse.style.background = 'var(--accent-green)';
        statusText.textContent = 'Live';
        statusText.style.color = 'var(--accent-green)';
    } else {
        pulse.style.background = 'var(--accent-amber)';
        statusText.textContent = 'Reconnecting...';
        statusText.style.color = 'var(--accent-amber)';
    }
}

/**
 * Update Wiz light card
 */
function updateWizCard(data) {
    const statusBadge = document.querySelector('#wizStatus .badge');
    const powerEl = document.getElementById('wizPower');
    const errorEl = document.getElementById('wizError');
    const card = document.getElementById('wizCard');

    card.classList.remove('loading');

    if (!data.available) {
        statusBadge.className = 'badge offline';
        statusBadge.textContent = 'Offline';
        powerEl.textContent = '--';
        errorEl.textContent = data.error || 'Device unavailable';
        errorEl.style.display = 'block';
        return;
    }

    errorEl.style.display = 'none';

    if (data.is_on) {
        statusBadge.className = 'badge online';
        statusBadge.textContent = 'On';
        powerEl.textContent = 'ON';
        powerEl.className = 'metric-value on';
    } else {
        statusBadge.className = 'badge standby';
        statusBadge.textContent = 'Standby';
        powerEl.textContent = 'OFF';
        powerEl.className = 'metric-value off';
    }
}

/**
 * Update Dreo humidifier card
 */
function updateDreoCard(data) {
    const statusBadge = document.querySelector('#dreoStatus .badge');
    const powerEl = document.getElementById('dreoPower');
    const humidityEl = document.getElementById('dreoHumidity');
    const targetEl = document.getElementById('dreoTarget');
    const modeEl = document.getElementById('dreoMode');
    const waterEl = document.getElementById('dreoWater');
    const dayEl = document.getElementById('dreoRuntimeDay');
    const weekEl = document.getElementById('dreoRuntimeWeek');
    const allEl = document.getElementById('dreoRuntimeAll');
    const errorEl = document.getElementById('dreoError');
    const card = document.getElementById('dreoCard');

    card.classList.remove('loading');

    if (!data.available) {
        statusBadge.className = 'badge offline';
        statusBadge.textContent = 'Offline';
        powerEl.textContent = '--';
        humidityEl.textContent = '--%';
        targetEl.textContent = '--%';
        modeEl.textContent = '--';
        waterEl.textContent = '--';
        if (dayEl) dayEl.textContent = '--%';
        if (weekEl) weekEl.textContent = '--%';
        if (allEl) allEl.textContent = '--%';
        errorEl.textContent = data.error || 'Device unavailable';
        errorEl.style.display = 'block';
        return;
    }

    errorEl.style.display = 'none';

    if (data.is_on) {
        statusBadge.className = 'badge online';
        statusBadge.textContent = 'On';
        powerEl.textContent = 'ON';
        powerEl.className = 'metric-value on';
    } else {
        statusBadge.className = 'badge standby';
        statusBadge.textContent = 'Standby';
        powerEl.textContent = 'OFF';
        powerEl.className = 'metric-value off';
    }

    // Fix: Backend returns 'current_humidity', not 'humidity'
    humidityEl.textContent = data.current_humidity !== undefined && data.current_humidity !== null ? `${data.current_humidity}%` : '--';
    targetEl.textContent = data.target_humidity !== undefined && data.target_humidity !== null ? `${data.target_humidity}%` : '--';
    modeEl.textContent = data.mode || '--';

    // Check key depending on backend response, usually 'water_tank_empty'
    // If true, it means empty/warning. If false/u ndefined, it's OK.
    const isWaterEmpty = data.water_tank_empty === true;
    waterEl.textContent = isWaterEmpty ? '⚠️ Empty' : '✓ OK';
    waterEl.className = `metric-value ${isWaterEmpty ? 'off' : ''}`; // Add color if empty?

    // Runtime Stats
    if (data.runtime_stats) {
        if (dayEl) dayEl.textContent = `${data.runtime_stats.day}%`;
        if (weekEl) weekEl.textContent = `${data.runtime_stats.week}%`;
        if (allEl) allEl.textContent = `${data.runtime_stats.all_time}%`;
    }

    // Check for notifications
    checkWaterNotification(data);
}


// --- Notifications & PWA ---

let lastNotificationTime = 0;
const NOTIFICATION_COOLDOWN = 4 * 60 * 60 * 1000; // 4 hours

function checkWaterNotification(data) {
    // Logic: If water tank is empty AND (never notified OR cooldown passed)
    if (data.water_tank_empty === true) {
        const now = Date.now();
        if (now - lastNotificationTime > NOTIFICATION_COOLDOWN) {
            sendNotification("💧 Humidifier Alert", "Water tank is empty! Please refill.");
            lastNotificationTime = now;
        }
    }
}

function sendNotification(title, body) {
    if (!("Notification" in window)) return;

    if (Notification.permission === "granted") {
        try {
            const notification = new Notification(title, {
                body: body,
                icon: 'https://api.iconify.design/noto:potted-plant.svg', // Use same icon as PWA
                tag: 'smart-tent-alert' // Prevent stacking
            });
            notification.onclick = function () { window.focus(); };
        } catch (e) {
            console.error("Notification error:", e);
        }
    }
}

// Register Service Worker & Request Permissions
window.addEventListener('load', () => {
    // Service Worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => console.log('SW registered!', reg))
            .catch(err => console.log('SW registration failed:', err));
    }
    // Notifications
    if ("Notification" in window && Notification.permission !== "granted" && Notification.permission !== "denied") {
        // Request on user interaction usually, but let's try on load or wait for first click
        // Modern browsers block auto-request.
        // We'll add a simple click listener to the body or a specific element if needed.
        // For now, let's try requesting immediately (might be blocked) or assume user has interactions.
        // Better: trigger on first click anywhere
        document.body.addEventListener('click', function requestNote() {
            Notification.requestPermission();
            document.body.removeEventListener('click', requestNote);
        }, { once: true });
    }
});


// --- PWA Install Prompt ---

let deferredPrompt;
// Global listener must be active immediately
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    // We can't update UI here yet if DOM isn't ready, but we set the var.
    // If DOM is already ready, we update.
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        showInstallModal(true);
    }
});

function showInstallModal(hasNativePrompt) {
    const installModal = document.getElementById('installModal');
    const btnInstall = document.getElementById('btnInstall');
    const btnDismiss = document.getElementById('btnDismiss');
    const modalText = document.querySelector('.modal-text p');

    if (!installModal) return;

    installModal.style.display = 'flex';
    if (btnInstall) btnInstall.style.display = 'inline-block';

    if (hasNativePrompt) {
        modalText.textContent = "Install this app on your home screen for quick access and offline support.";
    } else {
        modalText.textContent = "Install this app for the full experience.";
    }
}

// Bind UI interactions after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const btnInstall = document.getElementById('btnInstall');
    const btnDismiss = document.getElementById('btnDismiss');
    const installModal = document.getElementById('installModal');
    const modalText = document.querySelector('.modal-text p');

    // Check if we already missed the event or need to show manual fallback
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
    // Stricter mobile check: must have coarse pointer (touch) AND be small screen
    const isMobile = window.matchMedia('(max-width: 768px)').matches && window.matchMedia('(pointer: coarse)').matches;

    if (!isStandalone && isMobile) {
        // If we already have the prompt (fired before DOMContentLoaded)
        if (deferredPrompt) {
            showInstallModal(true);
        } else {
            // Wait a moment for it
            setTimeout(() => {
                // If native prompt arrived late, we might have it now
                if (deferredPrompt) {
                    showInstallModal(true);
                } else {
                    // Force show manual instructions if no prompt
                    showInstallModal(false);
                }
            }, 2000);
        }
    }

    if (btnInstall) {
        btnInstall.onclick = async () => {
            if (deferredPrompt) {
                // Success: Native Prompt
                if (installModal) installModal.style.display = 'none';
                deferredPrompt.prompt();
                const { outcome } = await deferredPrompt.userChoice;
                console.log(`User response: ${outcome}`);
                deferredPrompt = null;
            } else {
                // Failure: Manual Instructions
                const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
                // Simplify text to ensure it renders correctly
                const action = isIOS ? "Tap Share -> Add to Home Screen" : "Tap Menu (⋮) -> Install App";

                modalText.innerHTML = `
                    <div style="text-align: left; background: rgba(255,255,255,0.05); padding: 10px; border-radius: 8px;">
                        <strong>Manual Install:</strong><br><br>
                        1. ${action}<br>
                        2. Confirm 'Install'
                    </div>
                `;
                btnInstall.style.display = 'none';
                if (btnDismiss) btnDismiss.textContent = "Close";
            }
        };
    }

    if (btnDismiss) {
        btnDismiss.onclick = () => {
            if (installModal) installModal.style.display = 'none';
            localStorage.setItem('installDismissed', 'true');
        };
    }
});

/**
 * Update Tapo energy monitor card
 */
function updateTapoCard(data) {
    const statusBadge = document.querySelector('#tapoStatus .badge');
    const powerEl = document.getElementById('tapoPower');
    const todayEl = document.getElementById('tapoToday');
    const monthEl = document.getElementById('tapoMonth');
    const monthCostEl = document.getElementById('tapoMonthCost');
    const yearEl = document.getElementById('tapoYear');
    const yearCostEl = document.getElementById('tapoYearCost');
    const errorEl = document.getElementById('tapoError');
    const card = document.getElementById('tapoCard');

    card.classList.remove('loading');

    const currency = data.currency || '€';

    if (!data.available) {
        statusBadge.className = 'badge offline';
        statusBadge.textContent = 'Offline';
        powerEl.textContent = '-- W';
        todayEl.textContent = '-- kWh';
        monthEl.textContent = '-- kWh';
        monthCostEl.textContent = `${currency} --`;
        if (yearEl) yearEl.textContent = '-- kWh';
        yearCostEl.textContent = `${currency} --`;
        errorEl.textContent = data.error || 'Device unavailable';
        errorEl.style.display = 'block';
        return;
    }

    errorEl.style.display = 'none';

    if (data.is_on) {
        statusBadge.className = 'badge online';
        statusBadge.textContent = 'On';
    } else {
        statusBadge.className = 'badge standby';
        statusBadge.textContent = 'Standby';
    }

    // Current power
    const watts = data.current_power_w !== undefined ? data.current_power_w.toFixed(1) : '--';
    powerEl.textContent = `${watts} W`;

    // Energy consumption in kWh
    todayEl.textContent = data.today_kwh !== undefined ? `${data.today_kwh.toFixed(2)} kWh` : '-- kWh';
    monthEl.textContent = data.month_kwh !== undefined ? `${data.month_kwh.toFixed(2)} kWh` : '-- kWh';

    // Year kWh
    if (yearEl) yearEl.textContent = data.year_kwh !== undefined ? `${data.year_kwh.toFixed(2)} kWh` : '-- kWh';

    // Cost calculations
    monthCostEl.textContent = data.month_cost !== undefined ? `${currency} ${data.month_cost.toFixed(2)}` : `${currency} --`;
    yearCostEl.textContent = data.year_cost !== undefined ? `${currency} ${data.year_cost.toFixed(2)}` : `${currency} --`;
}

/**
 * Handle incoming status update
 */
function handleStatusUpdate(data) {
    console.log('Received status update:', new Date().toLocaleTimeString());

    // Update each device card
    if (data.devices) {
        updateWizCard(data.devices.wiz);
        updateDreoCard(data.devices.dreo);
        updateTapoCard(data.devices.tapo);
    }

    // Update timestamp
    updateTimestamp(data.timestamp);
}

/**
 * Initialize Socket.IO connection
 */
function initSocketIO() {
    console.log('Initializing Socket.IO connection...');

    // Connect to the server
    socket = io();

    socket.on('connect', () => {
        console.log('Socket.IO connected!');
        updateConnectionStatus(true);
    });

    socket.on('disconnect', () => {
        console.log('Socket.IO disconnected');
        updateConnectionStatus(false);
    });

    socket.on('connect_error', (error) => {
        console.error('Socket.IO connection error:', error);
        updateConnectionStatus(false);
    });

    // Listen for status updates from server
    socket.on('status_update', handleStatusUpdate);
}

/**
 * Fallback: Fetch status via REST API
 */
async function fetchStatusFallback() {
    try {
        const response = await fetch('/api/status');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        handleStatusUpdate(data);
    } catch (error) {
        console.error('Fallback fetch failed:', error);
    }
}

/**
 * Initialize the dashboard
 */
function init() {
    console.log('Smart Tent Dashboard initializing...');

    // Check if Socket.IO is available
    if (typeof io !== 'undefined') {
        initSocketIO();
        console.log('Using Socket.IO for real-time updates');
    } else {
        console.log('Socket.IO not available, using polling fallback');
        fetchStatusFallback();
        setInterval(fetchStatusFallback, FALLBACK_REFRESH_INTERVAL);
    }
}

// Start the dashboard when DOM is ready
document.addEventListener('DOMContentLoaded', init);

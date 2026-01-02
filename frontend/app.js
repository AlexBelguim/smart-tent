/**
 * Smart Tent Dashboard - Frontend Application with Socket.IO
 */

// Socket.IO connection
let socket = null;
const FALLBACK_REFRESH_INTERVAL = 10000; // Fallback if Socket.IO fails

// --- Notification Settings ---
const DEFAULT_SETTINGS = {
    notifyWater: true,
    notifySocket: true,
    notifyPower: true,
    powerThreshold: 200
};

let notificationSettings = { ...DEFAULT_SETTINGS };

// State tracking for change detection
let lastWizState = null;
let lastPowerAboveThreshold = false;

// Cooldown tracking
const NOTIFICATION_COOLDOWNS = {
    water: { last: 0, duration: 4 * 60 * 60 * 1000 },    // 4 hours
    socket: { last: 0, duration: 60 * 1000 },            // 1 minute
    power: { last: 0, duration: 5 * 60 * 1000 }          // 5 minutes
};

function loadSettings() {
    try {
        const saved = localStorage.getItem('smartTentSettings');
        if (saved) {
            notificationSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
}

function saveSettings() {
    try {
        localStorage.setItem('smartTentSettings', JSON.stringify(notificationSettings));
    } catch (e) {
        console.error('Failed to save settings:', e);
    }
}

function getSettings() {
    return notificationSettings;
}

// Load settings on script init
loadSettings();

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

    // Check for socket notifications
    checkWizNotification(data);
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

    // Status: On = actively misting, Standby = powered but idle, Off = powered off
    if (data.is_working) {
        // Actively misting
        statusBadge.className = 'badge online';
        statusBadge.textContent = 'On';
        powerEl.textContent = 'ON';
        powerEl.className = 'metric-value on';
    } else if (data.is_on) {
        // Powered on but not misting (target humidity reached)
        statusBadge.className = 'badge standby';
        statusBadge.textContent = 'Standby';
        powerEl.textContent = 'IDLE';
        powerEl.className = 'metric-value standby';
    } else {
        // Powered off
        statusBadge.className = 'badge offline';
        statusBadge.textContent = 'Off';
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

function canNotify(type) {
    const cooldown = NOTIFICATION_COOLDOWNS[type];
    if (!cooldown) return true;
    const now = Date.now();
    return (now - cooldown.last) > cooldown.duration;
}

function markNotified(type) {
    if (NOTIFICATION_COOLDOWNS[type]) {
        NOTIFICATION_COOLDOWNS[type].last = Date.now();
    }
}

function checkWaterNotification(data) {
    if (!notificationSettings.notifyWater) return;

    if (data.water_tank_empty === true && canNotify('water')) {
        sendNotification("💧 Humidifier Alert", "Water tank is empty! Please refill.");
        markNotified('water');
    }
}

function checkWizNotification(data) {
    if (!notificationSettings.notifySocket) return;
    if (!data.available) return;

    const currentState = data.is_on;

    // Only notify on state CHANGE (not on first load)
    if (lastWizState !== null && currentState !== lastWizState && canNotify('socket')) {
        const stateText = currentState ? "turned ON 💡" : "turned OFF 🌙";
        sendNotification("Grow Lights", `Socket ${stateText}`);
        markNotified('socket');
    }

    lastWizState = currentState;
}

function checkPowerNotification(data) {
    if (!notificationSettings.notifyPower) return;
    if (!data.available) return;

    const power = data.current_power_w || 0;
    const threshold = notificationSettings.powerThreshold || 200;
    const isAbove = power > threshold;

    // Only notify when crossing ABOVE the threshold (not continuously)
    if (isAbove && !lastPowerAboveThreshold && canNotify('power')) {
        sendNotification("⚡ High Power Alert", `Power usage: ${power.toFixed(0)}W (threshold: ${threshold}W)`);
        markNotified('power');
    }

    lastPowerAboveThreshold = isAbove;
}

function sendNotification(title, body) {
    // Only send notifications in PWA mode
    if (!isRunningAsPWA) return;
    if (!("Notification" in window)) return;

    if (Notification.permission === "granted") {
        try {
            const notification = new Notification(title, {
                body: body,
                icon: '/icon.png',
                tag: 'smart-tent-' + title.replace(/\s/g, '-').toLowerCase()
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
            .then(reg => {
                console.log('SW registered!', reg);
                // Subscribe to push notifications in PWA mode
                if (isRunningAsPWA && 'PushManager' in window) {
                    subscribeToPush(reg);
                }
            })
            .catch(err => console.log('SW registration failed:', err));
    }
    // Notifications
    if ("Notification" in window && Notification.permission !== "granted" && Notification.permission !== "denied") {
        document.body.addEventListener('click', function requestNote() {
            Notification.requestPermission().then(permission => {
                if (permission === 'granted' && isRunningAsPWA) {
                    // Re-attempt push subscription after permission granted
                    navigator.serviceWorker.ready.then(reg => subscribeToPush(reg));
                }
            });
            document.body.removeEventListener('click', requestNote);
        }, { once: true });
    }
});

/**
 * Subscribe to Web Push notifications
 */
async function subscribeToPush(registration, forceUpdate = false) {
    try {
        console.log('[PUSH] Checking subscription...');

        // Get VAPID public key from server
        const response = await fetch('/api/push/key');
        const { publicKey } = await response.json();

        if (!publicKey) {
            console.error('[PUSH] No public key from server');
            return;
        }

        // Convert base64 to Uint8Array
        const urlBase64ToUint8Array = (base64String) => {
            const padding = '='.repeat((4 - base64String.length % 4) % 4);
            const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
            const rawData = window.atob(base64);
            return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
        };

        const serverKey = urlBase64ToUint8Array(publicKey);

        // Check if already subscribed
        const existingSub = await registration.pushManager.getSubscription();

        if (existingSub) {
            // Check if key matches
            const currentKeyBuffer = existingSub.options.applicationServerKey;

            // Convert ArrayBuffer to Uint8Array for comparison
            const currentKey = currentKeyBuffer ? new Uint8Array(currentKeyBuffer) : null;

            let keysMatch = true;
            if (currentKey) {
                if (currentKey.length !== serverKey.length) keysMatch = false;
                else {
                    for (let i = 0; i < currentKey.length; i++) {
                        if (currentKey[i] !== serverKey[i]) {
                            keysMatch = false;
                            break;
                        }
                    }
                }
            } else {
                keysMatch = false; // No key in existing subscription?
            }

            if (keysMatch && !forceUpdate) {
                console.log('[PUSH] Already subscribed with correct key');
                return;
            }

            console.log('[PUSH] Key mismatch or forced update. Re-subscribing...');
            await existingSub.unsubscribe();
        }

        // Request permission if needed
        if (Notification.permission !== 'granted') {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                console.log('[PUSH] Notification permission denied');
                return;
            }
        }

        // Subscribe
        const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: serverKey
        });

        console.log('[PUSH] New subscription endpoint:', subscription.endpoint);

        // Send subscription to server
        await fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(subscription.toJSON())
        });

        console.log('[PUSH] Subscribed successfully!');
        if (typeof updateNotificationStatus === 'function') updateNotificationStatus();

    } catch (error) {
        console.error('[PUSH] Subscription failed:', error);
    }
}


// --- PWA Install Prompt ---

// Check IMMEDIATELY if running as PWA - before any other logic
const isRunningAsPWA = window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.navigator.standalone === true; // iOS Safari

// Stricter mobile check: must have coarse pointer (touch) AND be small screen
const isMobileDevice = window.matchMedia('(max-width: 768px)').matches && window.matchMedia('(pointer: coarse)').matches;

// Debug logging
console.log('[PWA] Display mode standalone:', window.matchMedia('(display-mode: standalone)').matches);
console.log('[PWA] Display mode fullscreen:', window.matchMedia('(display-mode: fullscreen)').matches);
console.log('[PWA] Navigator standalone:', window.navigator.standalone);
console.log('[PWA] Is running as PWA:', isRunningAsPWA);
console.log('[PWA] Is mobile device:', isMobileDevice);

let deferredPrompt;

// Only set up install prompt listener if NOT already running as PWA AND on mobile
if (!isRunningAsPWA && isMobileDevice) {
    // Global listener must be active immediately
    window.addEventListener('beforeinstallprompt', (e) => {
        console.log('[PWA] beforeinstallprompt event fired');
        e.preventDefault();
        deferredPrompt = e;
        // We can't update UI here yet if DOM isn't ready, but we set the var.
        // If DOM is already ready, we update.
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            showInstallModal(true);
        }
    });
} else {
    console.log('[PWA] Skipping install prompt listener - PWA:', isRunningAsPWA, 'Mobile:', isMobileDevice);
}

function showInstallModal(hasNativePrompt) {
    const installModal = document.getElementById('installModal');
    const btnInstall = document.getElementById('btnInstall');
    const btnDismiss = document.getElementById('btnDismiss');
    const modalText = document.querySelector('.modal-text p');

    if (!installModal) return;

    // Guard: Never show if already running as PWA
    if (isRunningAsPWA) {
        console.log('[PWA] Not showing modal - running as PWA');
        return;
    }

    // Guard: Never show on non-mobile (desktop)
    if (!isMobileDevice) {
        console.log('[PWA] Not showing modal - not a mobile device');
        return;
    }

    console.log('[PWA] Showing install modal');
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

    // Skip ALL install logic if already running as PWA or not on mobile
    if (isRunningAsPWA || !isMobileDevice) {
        console.log('[PWA] DOMContentLoaded - skipping install logic (PWA:', isRunningAsPWA, 'Mobile:', isMobileDevice, ')');
        return;
    }

    // On mobile, not PWA - show install prompt
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

    // Check for power notifications
    checkPowerNotification(data);
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

    // Initialize settings modal
    initSettingsModal();
}

/**
 * Initialize settings modal
 */
function initSettingsModal() {
    const btnSettings = document.getElementById('btnSettings');
    const settingsModal = document.getElementById('settingsModal');
    const btnCloseSettings = document.getElementById('btnCloseSettings');

    // Only show settings in PWA mode (notifications only work in PWA)
    if (!isRunningAsPWA) {
        if (btnSettings) btnSettings.style.display = 'none';
        return;
    }

    // Settings form elements
    const notifyWater = document.getElementById('notifyWater');
    const notifySocket = document.getElementById('notifySocket');
    const notifyPower = document.getElementById('notifyPower');
    const powerThreshold = document.getElementById('powerThreshold');

    // Load current settings into form
    function loadSettingsToForm() {
        if (notifyWater) notifyWater.checked = notificationSettings.notifyWater;
        if (notifySocket) notifySocket.checked = notificationSettings.notifySocket;
        if (notifyPower) notifyPower.checked = notificationSettings.notifyPower;
        if (powerThreshold) powerThreshold.value = notificationSettings.powerThreshold;
    }

    // Save settings from form
    function saveSettingsFromForm() {
        notificationSettings.notifyWater = notifyWater?.checked ?? true;
        notificationSettings.notifySocket = notifySocket?.checked ?? true;
        notificationSettings.notifyPower = notifyPower?.checked ?? true;
        notificationSettings.powerThreshold = parseInt(powerThreshold?.value) || 200;
        saveSettings();
    }

    // Notification permission UI elements
    const notificationStatus = document.getElementById('notificationStatus');
    const notificationStatusText = document.getElementById('notificationStatusText');
    const btnEnableNotifications = document.getElementById('btnEnableNotifications');

    // Update notification permission status display
    function updateNotificationStatus() {
        if (!("Notification" in window)) {
            if (notificationStatusText) notificationStatusText.textContent = "Notifications: Not supported";
            if (btnEnableNotifications) btnEnableNotifications.style.display = 'none';
            if (notificationStatus) notificationStatus.className = 'notification-status denied';
            return;
        }

        const permission = Notification.permission;
        if (permission === 'granted') {
            if (notificationStatusText) notificationStatusText.textContent = "✓ Notifications enabled";
            if (btnEnableNotifications) btnEnableNotifications.style.display = 'none';
            if (notificationStatus) notificationStatus.className = 'notification-status granted';
        } else if (permission === 'denied') {
            if (notificationStatusText) notificationStatusText.textContent = "✗ Notifications blocked";
            if (btnEnableNotifications) btnEnableNotifications.style.display = 'none';
            if (notificationStatus) notificationStatus.className = 'notification-status denied';
        } else {
            if (notificationStatusText) notificationStatusText.textContent = "Notifications: Not enabled";
            if (btnEnableNotifications) btnEnableNotifications.style.display = 'block';
            if (notificationStatus) notificationStatus.className = 'notification-status';
        }
    }

    // Enable notifications button click
    if (btnEnableNotifications) {
        btnEnableNotifications.onclick = async () => {
            try {
                // Pulse effect
                btnEnableNotifications.textContent = "Checking...";

                const permission = await Notification.requestPermission();
                updateNotificationStatus();

                if (permission === 'granted') {
                    // Subscribe to push notifications (Force update to ensure key match)
                    const reg = await navigator.serviceWorker.ready;
                    await subscribeToPush(reg, true);
                }
            } catch (e) {
                console.error('Notification permission error:', e);
                btnEnableNotifications.textContent = "Error";
            }
        };
    }

    // Open modal
    if (btnSettings) {
        btnSettings.onclick = () => {
            loadSettingsToForm();
            updateNotificationStatus();
            if (settingsModal) settingsModal.style.display = 'flex';
        };
    }

    // Close modal
    if (btnCloseSettings) {
        btnCloseSettings.onclick = () => {
            if (settingsModal) settingsModal.style.display = 'none';
        };
    }

    // Save on change
    [notifyWater, notifySocket, notifyPower, powerThreshold].forEach(el => {
        if (el) {
            el.addEventListener('change', saveSettingsFromForm);
        }
    });

    // Close on background click
    if (settingsModal) {
        settingsModal.onclick = (e) => {
            if (e.target === settingsModal) {
                settingsModal.style.display = 'none';
            }
        };
    }
}

// Start the dashboard when DOM is ready
document.addEventListener('DOMContentLoaded', init);

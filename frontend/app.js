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
    notifyHumidityLow: true,
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
    power: { last: 0, duration: 5 * 60 * 1000 },         // 5 minutes
    humidityLow: { last: 0, duration: 15 * 60 * 1000 }   // 15 minutes
};

// Global data storage for interactive tiles
let currentTapoData = null;
let currentDreoData = null;

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
        statusBadge.className = 'badge offline';
        statusBadge.textContent = 'Off';
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

    const dayEl = document.getElementById('dreoRuntimeDay');
    const weekEl = document.getElementById('dreoRuntimeWeek');
    const allEl = document.getElementById('dreoRuntimeAll');
    const errorEl = document.getElementById('dreoError');
    const card = document.getElementById('dreoCard');

    // Update global data
    currentDreoData = data;

    card.classList.remove('loading');

    if (!data.available) {
        statusBadge.className = 'badge offline';
        statusBadge.textContent = 'Offline';
        powerEl.textContent = '--';
        humidityEl.textContent = '--%';
        targetEl.textContent = '--%';
        modeEl.textContent = '--';

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

    // Runtime Stats
    if (data.runtime_stats) {
        if (dayEl) dayEl.textContent = `${data.runtime_stats.day}%`;
        if (weekEl) weekEl.textContent = `${data.runtime_stats.week}%`;
        if (allEl) allEl.textContent = `${data.runtime_stats.all_time}%`;
    }

    // Check for notifications
    checkWaterNotification(data);
    checkHumidityLowNotification(data);
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

    // Logic: If humidifier is OFF (not idle, but actually off) and humidity is 3% below target,
    // the tank is likely empty because it stopped working.
    const current = data.current_humidity;
    const target = data.target_humidity;
    const isOn = data.is_on;

    // Only trigger if: device is OFF, we have valid readings, and humidity is 3%+ below target
    if (isOn === false && current && target) {
        if (current < (target - 3) && canNotify('water')) {
            sendNotification("💧 Tank Empty", `Humidity is ${current}% (Target: ${target}%). Refill the water tank.`);
            markNotified('water');
        }
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

function checkHumidityLowNotification(data) {
    if (!notificationSettings.notifyHumidityLow) return;
    if (!data.available) return;

    const current = data.current_humidity;
    const target = data.target_humidity;

    if (current != null && target != null && current < (target - 10) && canNotify('humidityLow')) {
        sendNotification("🌡️ Humidity Low", `Humidity is ${current}% — ${target - current}% below target (${target}%).`);
        markNotified('humidityLow');
    }
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
    const todayCostEl = document.getElementById('tapoTodayCost');
    const todayCostTile = document.getElementById('tapoTodayCostTile');
    const yearEl = document.getElementById('tapoYear');
    const yearCostEl = document.getElementById('tapoYearCost');
    const errorEl = document.getElementById('tapoError');
    const card = document.getElementById('tapoCard');

    // Update global data
    currentTapoData = data;

    card.classList.remove('loading');

    const currency = data.currency || '€';

    if (!data.available) {
        statusBadge.className = 'badge offline';
        statusBadge.textContent = 'Offline';
        powerEl.textContent = '-- W';
        todayEl.textContent = '-- kWh';
        monthEl.textContent = '-- kWh';
        if (todayCostEl) todayCostEl.textContent = `${currency} --`;
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
    if (todayCostEl) todayCostEl.textContent = data.today_cost !== undefined ? `${currency} ${data.today_cost.toFixed(2)}` : `${currency} --`;

    // Check for power notifications
    checkPowerNotification(data);
}

/**
 * Trigger a test notification
 */
function triggerTestNotification() {
    sendNotification("🔔 Test Notification", "This is a test notification with the new icon! 🌿");
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
        if (typeof updateFanCard === 'function') {
            updateFanCard(data.devices.fan, data.devices.wiz, data.devices.dreo);
        }
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

    // Initialize Camera
    initCameraCard();

    // Initialize Tile Interactions (static binding)
    initTileInteractions();
}

/**
 * Initialize interactions for static tiles (Energy, Humidifier)
 */
function initTileInteractions() {
    const tapoTodayCostTile = document.getElementById('tapoTodayCostTile');
    const tapoTodayTile = document.getElementById('tapoTodayTile');
    const dreoDayTile = document.getElementById('dreoDayTile');
    const dreoWeekTile = document.getElementById('dreoWeekTile');

    if (tapoTodayCostTile) {
        tapoTodayCostTile.onclick = () => {
            const currency = currentTapoData?.currency || '€';
            showEnergyHistory(currentTapoData?.history_7d, currency, 'cost');
        };
    }

    if (tapoTodayTile) {
        tapoTodayTile.onclick = () => {
            const currency = currentTapoData?.currency || '€';
            showEnergyHistory(currentTapoData?.history_7d, currency, 'energy');
        };
    }

    if (dreoDayTile) {
        dreoDayTile.onclick = () => {
            showHumidifierHistory(currentDreoData?.runtime_stats?.history_7d);
        };
    }

    if (dreoWeekTile) {
        dreoWeekTile.onclick = () => {
            showHumidifierHistory(currentDreoData?.runtime_stats?.history_7w, "Last 7 Weeks Runtime");
        };
    }
}

/**
 * Initialize Camera Card interactions
 */
function initCameraCard() {
    const container = document.getElementById('cameraContainer');
    const feed = document.getElementById('cameraFeed');
    const loading = container?.querySelector('.camera-loading');
    const statusText = document.getElementById('cameraStatus');
    const statusBadge = document.getElementById('cameraStatusBadge').querySelector('.badge');

    if (!container || !feed) return;

    let isStreaming = false;

    function startStream() {
        // Show loading state immediately
        if (loading) loading.style.display = 'flex';

        // Add timestamp to prevent caching
        feed.src = "/video_feed?" + new Date().getTime();
        feed.style.display = 'block';
        container.classList.add('active');
        statusText.textContent = "REC";
        statusBadge.className = "badge streaming";
        isStreaming = true;
    }

    function stopStream() {
        feed.src = "";
        feed.style.display = 'none';
        if (loading) loading.style.display = 'none';
        container.classList.remove('active');
        statusText.textContent = "Ready";
        statusBadge.className = "badge";
        isStreaming = false;
    }

    // Toggle stream function
    function toggleStream() {
        if (isStreaming) {
            stopStream();
        } else {
            startStream();
        }
    }

    // click handler
    container.addEventListener('click', (e) => {
        if (e.target.tagName !== 'BUTTON') {
            toggleStream();
        }
    });

    const btnPlay = container.querySelector('.btn-play');
    if (btnPlay) {
        btnPlay.addEventListener('click', (e) => {
            e.stopPropagation();
            startStream();
        });
    }

    // When image actually loads (first frame received), hide loading spinner
    feed.addEventListener('load', () => {
        if (isStreaming && loading) {
            loading.style.display = 'none';
        }
    });

    // Handle image load error (e.g. backend offline)
    feed.addEventListener('error', () => {
        if (isStreaming) {
            console.error("Stream failed to load");
            statusText.textContent = "Error";
            statusBadge.className = "badge offline";
            if (loading) loading.style.display = 'none';
        }
    });
}

/**
 * Show Energy History Modal
 */
function showEnergyHistory(history, currency, mode = 'cost') {
    const modal = document.getElementById('energyHistoryModal');
    const list = document.getElementById('energyHistoryList');
    const closeBtn = document.getElementById('btnEnergyHistoryClose');
    const titleEl = modal?.querySelector('h3');

    if (!modal || !list) return;

    // Set title based on mode
    if (titleEl) {
        titleEl.textContent = mode === 'cost' ? 'Last 7 Days Cost' : 'Last 7 Days Energy';
    }

    if (!history || history.length === 0) {
        list.innerHTML = '<p style="text-align: center; color: var(--text-muted);">No history data available.</p>';
    } else {
        const headerValue = mode === 'cost' ? 'Cost' : 'Energy';
        let html = `<table class="history-table"><thead><tr><th>Date</th><th>${headerValue}</th></tr></thead><tbody>`;

        history.forEach(item => {
            const displayValue = mode === 'cost'
                ? `<div style="font-weight: 600;">${currency} ${item.cost.toFixed(2)}</div>`
                : `<div style="font-weight: 600;">${item.kwh.toFixed(3)} kWh</div>`;

            // Calculate bar width (arbitrary scaling for visualization)
            // Cost: max ~2.0, Energy: max ~10.0 ?? depends on user
            // Let's use relative scaling if possible? No, absolute for now.
            // Cost: width = price / 2 * 100
            // Energy: width = kwh / 5 * 100 (assuming 5kwh max/day)

            let percent = 0;
            if (mode === 'cost') {
                percent = Math.min((item.cost / 2.0) * 100, 100);
            } else {
                percent = Math.min((item.kwh / 5.0) * 100, 100);
            }

            html += `
                <tr>
                    <td>${new Date(item.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                    <td>
                        ${displayValue}
                        <div class="history-bar-container">
                            <div class="history-bar" style="width: ${percent}%; opacity: 0.7;"></div>
                        </div>
                    </td>
                </tr>
            `;
        });
        html += '</tbody></table>';
        list.innerHTML = html;
    }

    modal.style.display = 'flex';

    closeBtn.onclick = () => {
        modal.style.display = 'none';
    };

    // Clicking outside closes
    modal.onclick = (e) => {
        if (e.target === modal) modal.style.display = 'none';
    };
}

/**
 * Show Humidifier History Modal
 */
function showHumidifierHistory(history, titleOverride) {
    const modal = document.getElementById('humidifierHistoryModal');
    const list = document.getElementById('humidifierHistoryList');
    const closeBtn = document.getElementById('btnHumidifierHistoryClose');
    const titleEl = modal?.querySelector('h3');

    if (!modal || !list) return;

    if (titleEl) {
        titleEl.textContent = titleOverride || "Last 7 Days Runtime";
    }

    if (!history || history.length === 0) {
        list.innerHTML = '<p style="text-align: center; color: var(--text-muted);">No history data available.</p>';
    } else {
        let html = '<table class="history-table"><thead><tr><th>Period</th><th>On Time</th></tr></thead><tbody>';

        history.forEach(item => {
            let label = item.label;
            if (!label && item.date) {
                label = new Date(item.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
            }

            html += `
                <tr>
                    <td>${label}</td>
                    <td>
                        <div style="font-weight: 600;">${item.percent}%</div>
                         <div class="history-bar-container">
                            <div class="history-bar" style="width: ${item.percent}%; background-color: var(--accent-blue);"></div>
                        </div>
                    </td>
                </tr>
            `;
        });
        html += '</tbody></table>';
        list.innerHTML = html;
    }

    modal.style.display = 'flex';

    closeBtn.onclick = () => {
        modal.style.display = 'none';
    };

    modal.onclick = (e) => {
        if (e.target === modal) modal.style.display = 'none';
    };
}

/**
 * Initialize settings modal
 */
function initSettingsModal() {
    const btnSettings = document.getElementById('btnSettings');
    const settingsModal = document.getElementById('settingsModal');
    const btnCloseSettings = document.getElementById('btnCloseSettings');

    // Settings form elements - General
    const notifyWater = document.getElementById('notifyWater');
    const notifySocket = document.getElementById('notifySocket');
    const notifyPower = document.getElementById('notifyPower');
    const powerThreshold = document.getElementById('powerThreshold');

    // Settings form elements - Airflow (Dimensions)
    const tentWidth = document.getElementById('tentWidth');
    const tentDepth = document.getElementById('tentDepth');
    const tentHeight = document.getElementById('tentHeight');

    // --- Fan Management Helpers ---

    function renderFanList(containerId, fans, type) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';

        fans.forEach((fan, index) => {
            const div = document.createElement('div');
            div.className = 'fan-row';
            div.innerHTML = `
                <div class="fan-props">
                    <div class="fan-prop">
                        <label>Size (mm)</label>
                        <input type="number" class="fan-size" value="${fan.size || 150}" step="10">
                    </div>
                    <div class="fan-prop">
                        <label>Min RPM</label>
                        <input type="number" class="fan-min" value="${fan.min_rpm || 0}" step="100">
                    </div>
                    <div class="fan-prop">
                        <label>Max RPM</label>
                        <input type="number" class="fan-max" value="${fan.max_rpm || 2500}" step="100">
                    </div>
                </div>
                <button type="button" class="btn-icon-danger" onclick="removeFan('${type}', ${index})" title="Remove Fan">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                </button>
            `;
            container.appendChild(div);
        });
    }

    // Attach global helpers for onclick handlers
    window.addFan = function (type) {
        const newFan = { size: 150, min_rpm: 0, max_rpm: 2500 };
        if (type === 'exhaust') {
            if (!airflowConfig.exhaust_fans) airflowConfig.exhaust_fans = [];
            airflowConfig.exhaust_fans.push(newFan);
            renderFanList('exhaust-fans-list', airflowConfig.exhaust_fans, 'exhaust');
        } else {
            if (!airflowConfig.intake_fans) airflowConfig.intake_fans = [];
            airflowConfig.intake_fans.push(newFan);
            renderFanList('intake-fans-list', airflowConfig.intake_fans, 'intake');
        }
    };

    window.removeFan = function (type, index) {
        if (type === 'exhaust') {
            if (airflowConfig.exhaust_fans) {
                airflowConfig.exhaust_fans.splice(index, 1);
                renderFanList('exhaust-fans-list', airflowConfig.exhaust_fans, 'exhaust');
            }
        } else {
            if (airflowConfig.intake_fans) {
                airflowConfig.intake_fans.splice(index, 1);
                renderFanList('intake-fans-list', airflowConfig.intake_fans, 'intake');
            }
        }
    };

    // Tab Logic
    const tabs = document.querySelectorAll('.segmented-btn');
    const panels = document.querySelectorAll('.settings-panel');

    tabs.forEach(tab => {
        tab.onclick = () => {
            tabs.forEach(t => t.classList.remove('active'));
            panels.forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            const target = document.getElementById(`tab-${tab.dataset.tab}`);
            if (target) target.classList.add('active');
        };
    });

    // Load current settings into form
    function loadSettingsToForm() {
        // Notifications
        if (notifyWater) notifyWater.checked = notificationSettings.notifyWater;
        if (notifySocket) notifySocket.checked = notificationSettings.notifySocket;
        if (notifyPower) notifyPower.checked = notificationSettings.notifyPower;
        if (powerThreshold) powerThreshold.value = notificationSettings.powerThreshold;

        // Airflow
        if (tentWidth) tentWidth.value = airflowConfig.tent_width || 120;
        if (tentDepth) tentDepth.value = airflowConfig.tent_depth || 120;
        if (tentHeight) tentHeight.value = airflowConfig.tent_height || 200;

        // Render Lists
        renderFanList('exhaust-fans-list', airflowConfig.exhaust_fans || [], 'exhaust');

        renderFanList('intake-fans-list', airflowConfig.intake_fans || [], 'intake');
    }

    // Save settings from form
    function saveSettingsFromForm() {
        // Save Notifications (Local)
        notificationSettings.notifyWater = notifyWater?.checked ?? true;
        notificationSettings.notifySocket = notifySocket?.checked ?? true;
        notificationSettings.notifyPower = notifyPower?.checked ?? true;
        notificationSettings.notifyHumidityLow = document.getElementById('notifyHumidityLow')?.checked ?? true;
        notificationSettings.powerThreshold = parseInt(powerThreshold?.value) || 200;
        saveSettings();

        // Save Airflow (Backend)
        // Helper to scrape DOM inputs
        function getFansFromDOM(containerId) {
            const container = document.getElementById(containerId);
            if (!container) return [];
            const rows = container.querySelectorAll('.fan-row');
            const fans = [];
            rows.forEach(row => {
                fans.push({
                    size: parseInt(row.querySelector('.fan-size').value) || 150,
                    min_rpm: parseInt(row.querySelector('.fan-min').value) || 0,
                    max_rpm: parseInt(row.querySelector('.fan-max').value) || 2500
                });
            });
            return fans;
        }

        // Save Airflow (Backend)
        const newAirflow = {
            tent_width: parseInt(tentWidth?.value) || 120,
            tent_depth: parseInt(tentDepth?.value) || 120,
            tent_height: parseInt(tentHeight?.value) || 200,
            exhaust_fans: getFansFromDOM('exhaust-fans-list'),
            intake_fans: getFansFromDOM('intake-fans-list')
        };

        // Update local object immediately for UI updates
        airflowConfig = { ...airflowConfig, ...newAirflow };

        // Persist to server
        fetch('/api/fan/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(airflowConfig)
        }).catch(e => console.error('Failed to save airflow settings:', e));
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
        console.log('[Settings] Notification permission:', permission);

        if (permission === 'granted') {
            if (notificationStatusText) notificationStatusText.textContent = "✓ Notifications enabled";
            if (btnEnableNotifications) btnEnableNotifications.style.display = 'none';
            if (notificationStatus) notificationStatus.className = 'notification-status granted';
        } else if (permission === 'denied') {
            if (notificationStatusText) notificationStatusText.textContent = "✗ Notifications blocked";
            if (btnEnableNotifications) btnEnableNotifications.style.display = 'none';
            if (notificationStatus) notificationStatus.className = 'notification-status denied';
        } else {
            // permission === 'default' (not yet asked)
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
        btnSettings.style.display = ''; // Ensure visible
        btnSettings.onclick = () => {
            loadSettingsToForm();
            updateNotificationStatus();
            if (settingsModal) settingsModal.style.display = 'flex';
        };
    }

    // Close modal
    if (btnCloseSettings) {
        btnCloseSettings.onclick = () => {
            saveSettingsFromForm(); // Auto-save on close
            if (settingsModal) settingsModal.style.display = 'none';
        };
    }

    // Save on change (for checkboxes)
    [notifyWater, notifySocket, notifyPower, powerThreshold].forEach(el => {
        if (el) {
            el.addEventListener('change', saveSettingsFromForm);
        }
    });

    // Close on background click
    if (settingsModal) {
        settingsModal.onclick = (e) => {
            if (e.target === settingsModal) {
                saveSettingsFromForm(); // Auto-save
                settingsModal.style.display = 'none';
            }
        };
    }
}

// Start the dashboard when DOM is ready
document.addEventListener('DOMContentLoaded', init);

// ============== FAN CONTROL ==============

let fanAuthPin = null;  // Cached PIN for session
let pendingFanAction = null;  // { type: 'speed'|'daynight', data: any }
let fanDaySpeed = 75;   // Legacy compat
let fanNightSpeed = 30; // Legacy compat
let currentFanMode = 'night';  // 'day', 'night', or 'control'
let lastWizOn = null;   // Track wiz state for auto-switching
let humidityOverrideActive = false;  // True when humidity override is active

// Global Airflow Config
let airflowConfig = {
    day: 75, night: 30,
    tent_width: 120, tent_depth: 120, tent_height: 200,
    exhaust_fans: [],
    intake_fans: [],
    // Legacy keys kept for reference but will be migrated
    exhaust_count: 1, exhaust_size: 150, exhaust_max_rpm: 2500, exhaust_min_rpm: 0,
    intake_count: 0, intake_size: 150, intake_max_rpm: 2500, intake_min_rpm: 0,
};

// Load saved settings from backend
async function loadFanSettings() {
    try {
        const response = await fetch('/api/fan/settings');
        if (response.ok) {
            const data = await response.json();
            airflowConfig = { ...airflowConfig, ...data };

            // Migration: Convert legacy "count" to "fans" list if list is empty
            if (!airflowConfig.exhaust_fans || !Array.isArray(airflowConfig.exhaust_fans) || (airflowConfig.exhaust_fans.length === 0 && airflowConfig.exhaust_count > 0)) {
                if (!Array.isArray(airflowConfig.exhaust_fans)) airflowConfig.exhaust_fans = [];
                // Only migrate if empty
                if (airflowConfig.exhaust_fans.length === 0 && airflowConfig.exhaust_count > 0) {
                    for (let i = 0; i < airflowConfig.exhaust_count; i++) {
                        airflowConfig.exhaust_fans.push({
                            size: airflowConfig.exhaust_size || 150,
                            min_rpm: airflowConfig.exhaust_min_rpm || 0,
                            max_rpm: airflowConfig.exhaust_max_rpm || 2500
                        });
                    }
                } else if (airflowConfig.exhaust_fans.length === 0 && airflowConfig.exhaust_count === undefined) {
                    // Default 1 fan if total new install
                    airflowConfig.exhaust_fans.push({ size: 150, min_rpm: 0, max_rpm: 2500 });
                }
            }

            if (!airflowConfig.intake_fans || !Array.isArray(airflowConfig.intake_fans) || (airflowConfig.intake_fans.length === 0 && airflowConfig.intake_count > 0)) {
                if (!Array.isArray(airflowConfig.intake_fans)) airflowConfig.intake_fans = [];
                if (airflowConfig.intake_fans.length === 0 && airflowConfig.intake_count > 0) {
                    for (let i = 0; i < airflowConfig.intake_count; i++) {
                        airflowConfig.intake_fans.push({
                            size: airflowConfig.intake_size || 150,
                            min_rpm: airflowConfig.intake_min_rpm || 0,
                            max_rpm: airflowConfig.intake_max_rpm || 2500
                        });
                    }
                }
            }

            // Sync legacy vars
            fanDaySpeed = airflowConfig.day;
            fanNightSpeed = airflowConfig.night;

            console.log(`[FAN] Loaded settings: day=${fanDaySpeed}%, night=${fanNightSpeed}%`);

            // Update inputs if they exist (Fan Card)
            const dayInput = document.getElementById('fanDaySpeed');
            const nightInput = document.getElementById('fanNightSpeed');
            if (dayInput) dayInput.value = fanDaySpeed;
            if (nightInput) nightInput.value = fanNightSpeed;
        }
    } catch (e) {
        console.log('[FAN] Failed to load settings from backend:', e);
    }
}

// Initial load
loadFanSettings();

/**
 * Update fan card with status data and auto-switch based on lights/humidity
 */
function updateFanCard(data, wizData, dreoData) {
    const statusBadge = document.querySelector('#fanStatus .badge');
    const modeEl = document.getElementById('fanMode');
    const speedEl = document.getElementById('fanSpeed');
    const signalEl = document.getElementById('fanSignal');
    const errorEl = document.getElementById('fanError');
    const card = document.getElementById('fanCard');
    const dayInput = document.getElementById('fanDaySpeed');
    const nightInput = document.getElementById('fanNightSpeed');
    const btnApply = document.getElementById('btnFanApply');

    if (!card) return;

    card.classList.remove('loading');

    if (!data || !data.available) {
        statusBadge.className = 'badge offline';
        statusBadge.textContent = 'Offline';
        if (modeEl) modeEl.textContent = '--';
        speedEl.textContent = '--%';
        signalEl.textContent = '--';
        errorEl.textContent = data?.error || 'ESP32 unavailable';
        errorEl.style.display = 'block';
        if (dayInput) dayInput.disabled = true;
        if (nightInput) nightInput.disabled = true;
        if (btnApply) btnApply.disabled = true;
        return;
    }

    errorEl.style.display = 'none';

    // Get humidity thresholds from backend
    // Get humidity override state from backend (backend handles hysteresis logic)
    const shouldOverride = data.humidity_override === true;
    humidityOverrideActive = shouldOverride;

    // Determine mode: control > day > night
    const isDay = wizData && wizData.available && wizData.is_on;

    if (shouldOverride) {
        currentFanMode = 'control';
    } else {
        currentFanMode = isDay ? 'day' : 'night';
    }

    // Update mode display
    if (modeEl) {
        if (currentFanMode === 'control') {
            modeEl.textContent = '⚡ Control';
            modeEl.className = 'metric-value';
        } else {
            modeEl.textContent = isDay ? '☀️ Day' : '🌙 Night';
            modeEl.className = 'metric-value';
        }
    }

    // Update status badge
    if (currentFanMode === 'control') {
        statusBadge.className = 'badge control';
        statusBadge.textContent = 'Control';
    } else if (data.speed > 0) {
        statusBadge.className = 'badge online';
        statusBadge.textContent = currentFanMode === 'day' ? 'Day' : 'Night';
    } else {
        statusBadge.className = 'badge standby';
        statusBadge.textContent = 'Idle';
    }

    // Update speed display
    speedEl.textContent = `${data.speed}%`;
    speedEl.className = data.speed > 0 ? 'metric-value on' : 'metric-value off';

    // Update airflow footnote (dynamic calculation)
    try {
        const airflowEl = document.getElementById('fanAirflow');
        if (airflowEl) {
            const speedPct = parseInt(data.speed) || 0;

            if (speedPct > 0) {
                // Default config if loading failed
                const cfg = airflowConfig || {};
                const volWidth = cfg.tent_width || 120;
                const volDepth = cfg.tent_depth || 120;
                const volHeight = cfg.tent_height || 200;
                const volM3 = (volWidth * volDepth * volHeight) / 1000000;

                // Helper: Calculate total system flow at a given speed %
                const calculateSystemFlow = (pct) => {
                    let eFlow = 0;
                    let iFlow = 0;
                    let lastRPM = 0;

                    const getFlow = (fans) => {
                        let f = 0;
                        if (fans && Array.isArray(fans)) {
                            fans.forEach(fan => {
                                const size = fan.size || 150;
                                const minRPM = fan.min_rpm || 0;
                                const maxRPM = fan.max_rpm || 2500;

                                // Calculate max theoretical flow for this fan
                                // Flow ~ (Size/120)^2 * (RPM/2000) * 122
                                const maxFlow = Math.pow(size / 120, 2) * (maxRPM / 2000) * 122;

                                // Use power function for realistic performance curve
                                // airflow = speedPct^0.9 * maxFlow
                                const speedFraction = pct / 100;
                                const actualFlow = Math.pow(speedFraction, 0.9) * maxFlow;

                                f += actualFlow;

                                // Track RPM for display (linear interpolation for display only)
                                lastRPM = minRPM + (maxRPM - minRPM) * speedFraction;
                            });
                        }
                        return f;
                    };

                    eFlow = getFlow(cfg.exhaust_fans);
                    iFlow = getFlow(cfg.intake_fans);

                    // Return total (Max of In/Ex) and net difference
                    return { total: Math.max(eFlow, iFlow), net: iFlow - eFlow, rpm: lastRPM, eFlow, iFlow };
                };

                // Current Metrics
                const current = calculateSystemFlow(speedPct);
                const totalFlow = current.total;

                // Day/Night Metrics (for reference)
                const dayM = calculateSystemFlow(fanDaySpeed);
                const nightM = calculateSystemFlow(fanNightSpeed);

                const getExchangeTime = (flow) => (flow > 0 && volM3 > 0) ? (60 / (flow / volM3)).toFixed(1) + 'm' : '--';

                // Display
                let html = `🌀 Flow: <strong>${totalFlow.toFixed(0)} m³/h</strong>`;

                const minsPerExchange = (volM3 > 0 && totalFlow > 0) ? 60 / (totalFlow / volM3) : 0;
                if (minsPerExchange > 0 && minsPerExchange < 600) {
                    html += ` • Replace: <strong>${minsPerExchange.toFixed(1)}m</strong>`;
                }

                html += ` <small class="text-muted">(@ ~${current.rpm.toFixed(0)} RPM)</small>`;

                // Pressure
                if (current.eFlow > 0 || current.iFlow > 0) {
                    const ratio = totalFlow > 0 ? current.net / totalFlow : 0;
                    let pText = "Balanced Pressure";
                    let pColor = "var(--text-muted)";

                    if (ratio < -0.05) { pText = "Negative Pressure"; pColor = "var(--accent-green)"; }
                    else if (ratio > 0.05) { pText = "Positive Pressure"; pColor = "var(--accent-red)"; }

                    html += `<br><small style="color:${pColor}; opacity:0.9">${pText}</small>`;
                }

                // Footnote: Day/Night Reference
                html += `<div style="margin-top:0.5rem; border-top:1px solid rgba(255,255,255,0.1); padding-top:0.25rem; font-size:0.7em; color:var(--text-muted);">
                    Day (${fanDaySpeed}%): ${getExchangeTime(dayM.total)} / Night (${fanNightSpeed}%): ${getExchangeTime(nightM.total)}
                </div>`;

                airflowEl.innerHTML = html;
            } else {
                airflowEl.innerHTML = '🌀 Fan idle — no airflow';
            }
        }
    } catch (e) {
        console.warn('[FAN] Airflow calc error:', e);
    }

    // WiFi signal strength
    if (data.rssi) {
        const rssi = data.rssi;
        let signalText = 'Weak';
        if (rssi > -50) signalText = 'Excellent';
        else if (rssi > -60) signalText = 'Good';
        else if (rssi > -70) signalText = 'Fair';
        signalEl.textContent = signalText;
    } else {
        signalEl.textContent = '--';
    }

    // Update inputs
    if (dayInput && document.activeElement !== dayInput) {
        dayInput.value = fanDaySpeed;
        dayInput.disabled = false;
    }
    if (nightInput && document.activeElement !== nightInput) {
        nightInput.value = fanNightSpeed;
        nightInput.disabled = false;
    }
    if (btnApply) btnApply.disabled = false;

    // Auto-switch is now handled by backend (app.py check_fan_control)
    // We just track lastWizOn for UI purposes if needed, or remove it.
    if (wizData && wizData.available) {
        lastWizOn = wizData.is_on;
    }

    // Return to normal speed when humidity override ends
    if (!shouldOverride && humidityOverrideActive === false && currentFanMode !== 'control') {
        // Just exited override - restore day/night speed
    }
}

/**
 * Show PIN modal for authentication
 */
function showPinModal(action) {
    pendingFanAction = action;
    const modal = document.getElementById('fanPinModal');
    const input = document.getElementById('fanPinInput');
    const errorEl = document.getElementById('fanPinError');

    if (modal) {
        modal.style.display = 'flex';
        if (input) {
            input.value = '';
            input.focus();
        }
        if (errorEl) errorEl.style.display = 'none';
    }
}

/**
 * Execute pending fan action with PIN
 */
async function executeFanAction(pin) {
    if (!pendingFanAction) return;

    const errorEl = document.getElementById('fanPinError');

    try {
        let response;

        if (pendingFanAction.type === 'speed') {
            response = await fetch('/api/fan/speed', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ speed: pendingFanAction.data, code: pin })
            });
        } else if (pendingFanAction.type === 'schedule') {
            response = await fetch('/api/fan/schedule', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ schedules: pendingFanAction.data, code: pin })
            });
        }

        if (response && response.ok) {
            fanAuthPin = pin;  // Cache PIN on success
            closePinModal();

            // Refresh status
            if (socket) {
                socket.emit('request_update');
            }
        } else if (response && response.status === 403) {
            if (errorEl) {
                errorEl.textContent = 'Invalid PIN';
                errorEl.style.display = 'block';
            }
            fanAuthPin = null;  // Clear cached PIN
        } else {
            if (errorEl) {
                errorEl.textContent = 'Connection error';
                errorEl.style.display = 'block';
            }
        }
    } catch (e) {
        console.error('Fan action failed:', e);
        if (errorEl) {
            errorEl.textContent = 'Connection error';
            errorEl.style.display = 'block';
        }
    }
}

function closePinModal() {
    const modal = document.getElementById('fanPinModal');
    if (modal) modal.style.display = 'none';
    pendingFanAction = null;
}

/**
 * Auto-set fan speed (used when lights change)
 */
async function autoSetFanSpeed(speed) {
    if (!fanAuthPin) {
        console.log('[FAN] No cached PIN, skipping auto-switch');
        return;
    }

    try {
        const response = await fetch('/api/fan/speed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ speed: speed, code: fanAuthPin })
        });

        if (response.ok) {
            console.log(`[FAN] Auto-set speed to ${speed}%`);
            if (socket) socket.emit('request_update');
        }
    } catch (e) {
        console.error('[FAN] Auto-set failed:', e);
    }
}

/**
 * Save day/night settings and apply current mode speed
 */
async function saveDayNightSettings() {
    const dayInput = document.getElementById('fanDaySpeed');
    const nightInput = document.getElementById('fanNightSpeed');

    if (!dayInput || !nightInput) return;

    const newDaySpeed = parseInt(dayInput.value, 10) || 75;
    const newNightSpeed = parseInt(nightInput.value, 10) || 30;

    fanDaySpeed = Math.max(0, Math.min(100, newDaySpeed));
    fanNightSpeed = Math.max(0, Math.min(100, newNightSpeed));

    // Save to backend
    try {
        await fetch('/api/fan/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ day: fanDaySpeed, night: fanNightSpeed })
        });
        console.log('[FAN] Settings saved');
    } catch (e) {
        console.error('[FAN] Failed to save settings:', e);
    }

    // Apply current mode speed
    const targetSpeed = currentFanMode === 'day' ? fanDaySpeed : fanNightSpeed;

    if (fanAuthPin) {
        pendingFanAction = { type: 'speed', data: targetSpeed };
        executeFanAction(fanAuthPin);
    } else {
        showPinModal({ type: 'speed', data: targetSpeed });
    }
}

/**
 * Show schedule modal
 */
async function showScheduleModal() {
    const modal = document.getElementById('fanScheduleModal');
    const list = document.getElementById('scheduleList');

    if (!modal || !list) return;

    // Fetch latest schedules
    try {
        const response = await fetch('/api/fan/schedule');
        if (response.ok) {
            const data = await response.json();
            fanSchedules = data.schedules || [];
        }
    } catch (e) {
        console.error('Failed to fetch schedules:', e);
    }

    renderScheduleList();
    modal.style.display = 'flex';
}

function renderScheduleList() {
    const list = document.getElementById('scheduleList');
    if (!list) return;

    list.innerHTML = '';

    fanSchedules.forEach((sched, i) => {
        const item = document.createElement('div');
        item.className = 'schedule-item';
        item.innerHTML = `
            <input type="checkbox" class="sched-enabled" ${sched.enabled ? 'checked' : ''} data-id="${i}">
            <input type="time" class="sched-time" value="${String(sched.hour).padStart(2, '0')}:${String(sched.minute).padStart(2, '0')}" data-id="${i}">
            <input type="number" class="sched-speed" min="0" max="100" value="${sched.speed}" data-id="${i}">
            <span>%</span>
            <button class="btn-remove" data-id="${i}">✕</button>
        `;
        list.appendChild(item);
    });

    // Add event listeners
    list.querySelectorAll('.btn-remove').forEach(btn => {
        btn.onclick = () => {
            const id = parseInt(btn.dataset.id, 10);
            fanSchedules.splice(id, 1);
            renderScheduleList();
        };
    });
}

function addScheduleEntry() {
    fanSchedules.push({ enabled: true, hour: 12, minute: 0, speed: 50, id: fanSchedules.length });
    renderScheduleList();
}

function saveSchedules() {
    const list = document.getElementById('scheduleList');
    if (!list) return;

    // Collect schedule data from form
    const items = list.querySelectorAll('.schedule-item');
    const schedules = [];

    items.forEach((item, i) => {
        const enabled = item.querySelector('.sched-enabled').checked;
        const time = item.querySelector('.sched-time').value.split(':');
        const speed = parseInt(item.querySelector('.sched-speed').value, 10);

        schedules.push({
            id: i,
            enabled: enabled,
            hour: parseInt(time[0], 10) || 0,
            minute: parseInt(time[1], 10) || 0,
            speed: speed || 0
        });
    });

    if (fanAuthPin) {
        // Use cached PIN
        pendingFanAction = { type: 'schedule', data: schedules };
        executeFanAction(fanAuthPin);
        closeScheduleModal();
    } else {
        // Prompt for PIN
        closeScheduleModal();
        showPinModal({ type: 'schedule', data: schedules });
    }
}

function closeScheduleModal() {
    const modal = document.getElementById('fanScheduleModal');
    if (modal) modal.style.display = 'none';
}

/**
 * Initialize fan control events
 */
function initFanControls() {
    // Save button (day/night settings)
    const btnApply = document.getElementById('btnFanApply');
    if (btnApply) {
        btnApply.onclick = saveDayNightSettings;
    }

    // Schedule button
    const btnSchedule = document.getElementById('btnFanSchedule');
    if (btnSchedule) {
        btnSchedule.onclick = showScheduleModal;
    }

    // PIN modal
    const btnPinCancel = document.getElementById('btnPinCancel');
    const btnPinSubmit = document.getElementById('btnPinSubmit');
    const pinInput = document.getElementById('fanPinInput');

    if (btnPinCancel) btnPinCancel.onclick = closePinModal;
    if (btnPinSubmit) {
        btnPinSubmit.onclick = () => {
            if (pinInput && pinInput.value.length === 4) {
                executeFanAction(pinInput.value);
            }
        };
    }
    if (pinInput) {
        pinInput.onkeydown = (e) => {
            if (e.key === 'Enter' && pinInput.value.length === 4) {
                executeFanAction(pinInput.value);
            }
        };
    }

    // Schedule modal
    const btnAddSchedule = document.getElementById('btnAddSchedule');
    const btnScheduleCancel = document.getElementById('btnScheduleCancel');
    const btnScheduleSave = document.getElementById('btnScheduleSave');

    if (btnAddSchedule) btnAddSchedule.onclick = addScheduleEntry;
    if (btnScheduleCancel) btnScheduleCancel.onclick = closeScheduleModal;
    if (btnScheduleSave) btnScheduleSave.onclick = saveSchedules;

    // Close modals on background click
    const pinModal = document.getElementById('fanPinModal');
    const schedModal = document.getElementById('fanScheduleModal');

    if (pinModal) {
        pinModal.onclick = (e) => {
            if (e.target === pinModal) closePinModal();
        };
    }
    if (schedModal) {
        schedModal.onclick = (e) => {
            if (e.target === schedModal) closeScheduleModal();
        };
    }
}

// Ensure fan controls and tile interactions are initialized when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    initFanControls();
    initTileInteractions();
    initCameraCard();
});

/**
 * wifi-sim.js — Wi-Fi State Engine
 *
 * This is the core Wi-Fi simulation for Voltloom.
 * It manages the CYW43 connection state at the SDK level.
 *
 * RESPONSIBILITIES:
 *   - Track initialization, STA mode, connection state
 *   - Store SSID and fake IP address
 *   - Provide query functions for connection status
 *   - Track onboard LED state (CYW43-connected LED)
 *
 * DOES NOT:
 *   - Perform real networking (the simulator has none: Wi-Fi association only)
 *   - Emulate CYW43 hardware registers
 *   - Touch the DOM or UI
 *   - Block the simulation loop
 *
 * SIMULATOR BEHAVIOR:
 *   - connect() succeeds instantly with fake IP 192.168.1.50
 *   - No timeout simulation (timeout param is accepted but not used)
 *   - Password is accepted but not validated
 *
 * This module is the "truth" for Wi-Fi state on the main thread.
 */

// ---------- Constants ----------

const FAKE_IP = '192.168.1.50';
const FAKE_GATEWAY = '192.168.1.1';
const FAKE_NETMASK = '255.255.255.0';

// ---------- Wi-Fi State ----------

/**
 * Wi-Fi state object:
 *   initialized : boolean — has cyw43_arch_init() been called?
 *   staMode     : boolean — is Station mode enabled?
 *   connected   : boolean — is connected to an AP?
 *   ssid        : string  — connected network name (empty if not connected)
 *   ipAddress   : string  — assigned IP address (empty if not connected)
 *   gateway     : string  — gateway address (empty if not connected)
 *   netmask     : string  — subnet mask (empty if not connected)
 *   onboardLed  : boolean — state of the CYW43 onboard LED
 */
const state = {
    initialized: false,
    staMode: false,
    connected: false,
    ssid: '',
    ipAddress: '',
    gateway: '',
    netmask: '',
    onboardLed: false
};

// ---------- Init / Deinit ----------

/**
 * Initialize the CYW43 driver.
 * Mirrors: cyw43_arch_init()
 *
 * @returns {number} — 0 on success (always succeeds in simulator)
 */
export function init() {
    state.initialized = true;
    return 0;
}

/**
 * De-initialize the CYW43 driver.
 * Mirrors: cyw43_arch_deinit()
 */
export function deinit() {
    state.initialized = false;
    state.staMode = false;
    state.connected = false;
    state.ssid = '';
    state.ipAddress = '';
    state.gateway = '';
    state.netmask = '';
    state.onboardLed = false;
}

// ---------- Mode ----------

/**
 * Enable Station (STA) mode.
 * Mirrors: cyw43_arch_enable_sta_mode()
 */
export function enableStaMode() {
    state.staMode = true;
}

// ---------- Connect / Disconnect ----------

/**
 * Connect to a Wi-Fi network.
 * In the simulator, this always succeeds instantly.
 * Mirrors: cyw43_arch_wifi_connect_timeout_ms()
 *
 * @param {string} ssid      — network name
 * @param {string} password  — network password (ignored in simulator)
 * @param {number} timeout   — timeout in ms (ignored in simulator)
 * @returns {number} — 0 on success (always succeeds)
 */
export function connect(ssid, password, timeout) {
    if (!state.initialized) return -1;
    if (!state.staMode) return -1;

    state.connected = true;
    state.ssid = ssid || 'SimulatedNetwork';
    state.ipAddress = FAKE_IP;
    state.gateway = FAKE_GATEWAY;
    state.netmask = FAKE_NETMASK;

    return 0;
}

/**
 * Disconnect from current network.
 */
export function disconnect() {
    state.connected = false;
    state.ssid = '';
    state.ipAddress = '';
    state.gateway = '';
    state.netmask = '';
}

// ---------- Onboard LED ----------

/**
 * Set the CYW43 onboard LED state.
 * Mirrors: cyw43_arch_gpio_put(CYW43_WL_GPIO_LED_PIN, value)
 *
 * @param {number} wlGpio — CYW43 GPIO (0 = onboard LED)
 * @param {boolean} value — true for ON, false for OFF
 */
export function setOnboardLed(wlGpio, value) {
    if (wlGpio === 0) {
        state.onboardLed = !!value;
    }
}

// ---------- Queries ----------

/**
 * Get a snapshot of the current WiFi state.
 *
 * @returns {object} — copy of the WiFi state
 */
export function getStatus() {
    return { ...state };
}

/**
 * Check if WiFi is connected.
 *
 * @returns {boolean}
 */
export function isConnected() {
    return state.connected;
}

/**
 * Get the assigned IP address.
 *
 * @returns {string} — IP address or empty string
 */
export function getIpAddress() {
    return state.ipAddress;
}

// ---------- Lifecycle ----------

/**
 * Reset all WiFi state to defaults.
 * Called on simulation stop or system reset.
 */
export function resetAll() {
    state.initialized = false;
    state.staMode = false;
    state.connected = false;
    state.ssid = '';
    state.ipAddress = '';
    state.gateway = '';
    state.netmask = '';
    state.onboardLed = false;
}

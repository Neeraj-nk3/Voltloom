/**
 * wifi-bridge.js — Wi-Fi Bridge Layer (Public API)
 *
 * This is the ONLY module that simulator-bridge.js and other parts of
 * the simulator should call for Wi-Fi operations.
 *
 * DATA FLOW:
 *   User code → wifi-bridge.wifiConnect(ssid, pw, timeout)
 *                 → wifi-sim.connect(ssid, pw, timeout)
 *                 → serial-output.print("[WiFi] Connected to ...")
 *
 * RESPONSIBILITIES:
 *   - Provide SDK-named functions matching cyw43_arch.h
 *   - Route WiFi config to wifi-sim
 *   - Print status messages to Serial Monitor
 *
 * DOES NOT:
 *   - Perform real networking
 *   - Touch the DOM or UI
 *   - Modify GPIO or PWM state
 */

import {
    init,
    deinit,
    enableStaMode,
    connect,
    disconnect,
    setOnboardLed,
    getStatus,
    isConnected,
    getIpAddress,
    resetAll
} from './wifi-sim.js';

import { print, debug } from '../ui/panels/serial-output.js';

// ---------- SDK-Style Functions ----------

/**
 * Initialize the CYW43 Wi-Fi driver.
 * Mirrors: cyw43_arch_init()
 *
 * @returns {number} — 0 on success
 */
export function wifiInit() {
    const result = init();
    if (result === 0) {
        print('[WiFi] CYW43 driver initialized');
    } else {
        print('[WiFi] ERROR: CYW43 initialization failed');
    }
    return result;
}

/**
 * De-initialize the CYW43 driver.
 * Mirrors: cyw43_arch_deinit()
 */
export function wifiDeinit() {
    deinit();
    print('[WiFi] CYW43 driver de-initialized');
}

/**
 * Enable Station (STA) mode.
 * Mirrors: cyw43_arch_enable_sta_mode()
 */
export function wifiEnableStaMode() {
    enableStaMode();
    debug('[WiFi] Station mode enabled');
}

/**
 * Connect to a Wi-Fi network.
 * Mirrors: cyw43_arch_wifi_connect_timeout_ms()
 *
 * @param {string} ssid      — network name
 * @param {string} password  — network password
 * @param {number} timeout   — timeout in ms (unused in simulator)
 * @returns {number} — 0 on success
 */
export function wifiConnect(ssid, password, timeout) {
    const result = connect(ssid, password, timeout);
    if (result === 0) {
        const status = getStatus();
        print(`[WiFi] Connected to "${status.ssid}"`);
        print(`[WiFi] IP Address: ${status.ipAddress}`);
        print(`[WiFi] Gateway:    ${status.gateway}`);
        print(`[WiFi] Netmask:    ${status.netmask}`);
    } else {
        print('[WiFi] ERROR: Connection failed (not initialized or STA mode not enabled)');
    }
    return result;
}

/**
 * Disconnect from current network.
 */
export function wifiDisconnect() {
    disconnect();
    print('[WiFi] Disconnected');
}

/**
 * Control the CYW43 onboard LED.
 * Mirrors: cyw43_arch_gpio_put()
 *
 * @param {number} wlGpio — CYW43 GPIO (0 = onboard LED)
 * @param {boolean} value — true for ON, false for OFF
 */
export function wifiGpioPut(wlGpio, value) {
    setOnboardLed(wlGpio, value);
    debug(`[WiFi] Onboard LED ${value ? 'ON' : 'OFF'}`);
}

// ---------- Query Functions ----------

/**
 * Get WiFi connection status.
 *
 * @returns {object} — { initialized, staMode, connected, ssid, ipAddress, ... }
 */
export function wifiGetStatus() {
    return getStatus();
}

/**
 * Check if WiFi is connected.
 *
 * @returns {boolean}
 */
export function wifiIsConnected() {
    return isConnected();
}

/**
 * Get the assigned IP address.
 *
 * @returns {string}
 */
export function wifiGetIpAddress() {
    return getIpAddress();
}

// ---------- Lifecycle ----------

/**
 * Reset all WiFi state.
 * Called on simulation stop or system reset.
 */
export function resetWifi() {
    resetAll();
}

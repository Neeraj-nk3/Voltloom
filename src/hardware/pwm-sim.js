/**
 * pwm-sim.js — PWM State Engine
 *
 * This is the core PWM hardware simulation for Voltloom.
 * It manages 8 PWM slices, each with 2 channels (A and B), matching
 * the real Pico's PWM hardware.
 *
 * RESPONSIBILITIES:
 *   - Track slice state: wrap value, channel levels, enabled flag
 *   - Map GPIO pins to slices/channels (Pico hardware mapping)
 *   - Calculate duty cycle as level / (wrap + 1)
 *   - Report whether a GPIO has active PWM
 *
 * DOES NOT:
 *   - Generate actual waveforms or timing signals
 *   - Touch the DOM or UI
 *   - Communicate with the Web Worker
 *   - Modify GPIO state (PWM is a separate layer)
 *
 * PICO PWM MAPPING:
 *   Slice   = floor(GPIO / 2)
 *   Channel = GPIO % 2   (0 = A, 1 = B)
 *
 * PwmEngine is instance-based: the main thread has one (used through the functions at the bottom), and
 * each firmware worker creates its own so it can feed PWM-driven pins into its electrical model.
 */

// ---------- Constants ----------

const NUM_SLICES = 8;    // Pico has 8 PWM slices
const NUM_CHANNELS = 2;  // Each slice has 2 channels (A, B)
const DEFAULT_WRAP = 65535; // 16-bit counter max
export const PWM_SYSTEM_CLOCK_HZ = 125_000_000;   // the RP2040 system clock that feeds the PWM counters
const MIN_CLKDIV = 1;
const MAX_CLKDIV = 255 + 15 / 16;   // 8-bit integer + 4-bit fraction

// ---------- Slice State ----------

/**
 * Each slice is an object:
 *   wrap     : number   — counter wrap (TOP) value (0–65535)
 *   levels   : number[] — compare level per channel [A, B] (0–65535)
 *   enabled  : boolean  — whether the slice is running
 */
function createDefaultSlice() {
    return {
        wrap: DEFAULT_WRAP,
        levels: [0, 0],  // [Channel A, Channel B]
        clkdiv: 1,       // counter clock divider (1 .. 255.9375, in steps of 1/16)
        enabled: false
    };
}

// ---------- GPIO ↔ Slice Mapping ----------

/**
 * Get the PWM slice number for a GPIO pin.
 * Mirrors: pwm_gpio_to_slice_num()
 *
 * Mapping (matches the Pico SDK's pwm_gpio_to_slice_num): slice = (gpio >> 1) & 7.
 * GP16–GP29 therefore wrap onto slices 0–6 and share them with GP0–GP13.
 *
 * @param {number} gpio — GPIO number (0–29)
 * @returns {number} — slice number (0–7), or -1 if gpio is not a valid GPIO
 */
export function gpioToSlice(gpio) {
    if (!Number.isInteger(gpio) || gpio < 0 || gpio > 29) return -1;
    return (gpio >> 1) & (NUM_SLICES - 1);
}

/**
 * Get the PWM channel for a GPIO pin.
 *
 * Mapping: channel = gpio % 2  (0 = A, 1 = B)
 *
 * @param {number} gpio — GPIO number (0–29)
 * @returns {number} — 0 (channel A) or 1 (channel B)
 */
export function gpioToChannel(gpio) {
    return gpio % 2;
}

// ---------- The engine (instance-based, so every firmware worker owns its own) ----------

export class PwmEngine {
    constructor() {
        this.slices = Array.from({ length: NUM_SLICES }, createDefaultSlice);
    }

    /** Mirrors pwm_set_wrap(): the counter counts 0..wrap. */
    setWrap(slice, wrap) {
        if (slice < 0 || slice >= NUM_SLICES) return;
        this.slices[slice].wrap = Math.max(0, Math.min(65535, wrap));
    }

    /** Mirrors pwm_set_chan_level(): duty cycle = level / (wrap + 1). */
    setLevel(slice, channel, level) {
        if (slice < 0 || slice >= NUM_SLICES) return;
        if (channel < 0 || channel >= NUM_CHANNELS) return;
        this.slices[slice].levels[channel] = Math.max(0, Math.min(65535, level));
    }

    /** Mirrors pwm_set_clkdiv(): the divider is limited to 1..255.9375 and rounded to the hardware's 1/16 steps. */
    setClkdiv(slice, div) {
        if (slice < 0 || slice >= NUM_SLICES) return;
        const value = Number(div);
        if (!Number.isFinite(value)) return;
        const clamped = Math.min(MAX_CLKDIV, Math.max(MIN_CLKDIV, value));
        this.slices[slice].clkdiv = Math.round(clamped * 16) / 16;
    }

    /** PWM output frequency of a GPIO in Hz: system clock / (clkdiv * (wrap + 1)); 0 if its slice is not enabled. */
    getFrequencyHz(gpio) {
        const slice = gpioToSlice(gpio);
        if (slice < 0 || !this.slices[slice].enabled) return 0;
        const { clkdiv, wrap } = this.slices[slice];
        return PWM_SYSTEM_CLOCK_HZ / (clkdiv * (wrap + 1));
    }

    /** Mirrors pwm_set_enabled(). */
    setEnabled(slice, enabled) {
        if (slice < 0 || slice >= NUM_SLICES) return;
        this.slices[slice].enabled = !!enabled;
    }

    /** Duty cycle of a GPIO as 0.0–1.0 (level / (wrap + 1)); 0 if its slice is not enabled. */
    getDutyCycle(gpio) {
        const slice = gpioToSlice(gpio);
        if (slice < 0 || !this.slices[slice].enabled) return 0;

        const level = this.slices[slice].levels[gpioToChannel(gpio)];
        const wrap = this.slices[slice].wrap;

        // Avoid division by zero
        if (wrap === 0) return level > 0 ? 1 : 0;

        return Math.min(1, level / (wrap + 1));
    }

    /** Active means: the slice is enabled AND the level is > 0. */
    isActive(gpio) {
        const slice = gpioToSlice(gpio);
        if (slice < 0 || !this.slices[slice].enabled) return false;
        return this.slices[slice].levels[gpioToChannel(gpio)] > 0;
    }

    getSliceState(slice) {
        if (slice < 0 || slice >= NUM_SLICES) return null;
        return { ...this.slices[slice], levels: [...this.slices[slice].levels] };
    }

    reset() {
        for (let i = 0; i < NUM_SLICES; i++) this.slices[i] = createDefaultSlice();
    }
}

// ---------- Main-thread engine (module-level functions kept for the existing callers) ----------

const mainEngine = new PwmEngine();

export const setWrap = (slice, wrap) => mainEngine.setWrap(slice, wrap);
export const setLevel = (slice, channel, level) => mainEngine.setLevel(slice, channel, level);
export const setEnabled = (slice, enabled) => mainEngine.setEnabled(slice, enabled);
export const getDutyCycle = (gpio) => mainEngine.getDutyCycle(gpio);
export const setClkdiv = (slice, div) => mainEngine.setClkdiv(slice, div);
export const getFrequencyHz = (gpio) => mainEngine.getFrequencyHz(gpio);
export const isPwmActive = (gpio) => mainEngine.isActive(gpio);
export const getSliceState = (slice) => mainEngine.getSliceState(slice);
export const resetAll = () => mainEngine.reset();

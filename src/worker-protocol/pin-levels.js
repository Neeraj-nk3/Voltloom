/**
 * pin-levels.js — how an input pin's external drive is shared with the firmware worker.
 *
 * The main thread decides what the circuit drives onto each GPIO (wired to ground, wired to a
 * power rail, or nothing) and writes it into a SharedArrayBuffer cell per pin. The firmware
 * worker reads that cell. FLOATING means "nothing drives this pin": the pin's own pull
 * resistor, which only the firmware side knows about, decides the value.
 */

export const FLOATING = -1;

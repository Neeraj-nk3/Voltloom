/**
 * This file handles the LED component.
 * It creates the LED using SVG and shows its pins.
 * It also allows dragging and color changes.
 *
 * This file does NOT handle simulation or code execution.
 */

import { assertSafeComponentId } from '../../shared/ids.js';
import { ledColorMap } from '../../shared/colors.js';

export function createLED(id, x, y, ledCount, canvasManager) {
    assertSafeComponentId(id); // id is interpolated into markup below
    const label = `led${ledCount}`;
    const div = document.createElement('div');

    div.id = id;
    div.className = 'part part--led';
    div.style.left = `${x}px`;
    div.style.top = `${y}px`;

    div.innerHTML = `
        <div class="led-label part-label">LED ${ledCount}</div>
        <svg width="100" height="200" viewBox="0 0 100 200" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <linearGradient id="led-grad-${id}" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop id="stop1-${id}" offset="0%" stop-color="#ff4d4d" />
                    <stop id="stop2-${id}" offset="50%" stop-color="#ff0000" />
                    <stop id="stop3-${id}" offset="100%" stop-color="#cc0000" />
                </linearGradient>
            </defs>
            <!-- Larger Hit Areas for Pins (Visible stroke for hover state) -->
            <path data-tooltip="${label}:C" data-pin="C" d="M35,110 L35,150" stroke="#999" stroke-width="12" stroke-linecap="round" style="pointer-events:all; cursor:crosshair" class="pin-hit-area transition-colors"></path>
            <path data-tooltip="${label}:A" data-pin="A" d="M65,110 L65,140 L80,155" stroke="#999" stroke-width="12" stroke-linecap="round" fill="none" style="pointer-events:all; cursor:crosshair" class="pin-hit-area transition-colors"></path>
            
            <path d="M20,60 Q20,10 50,10 Q80,10 80,60 L80,100 L20,100 Z" fill="url(#led-grad-${id})" style="pointer-events:none" />
            <rect id="led-base-${id}" x="15" y="100" width="70" height="10" rx="2" fill="#cc0000" style="pointer-events:none" />
            <ellipse cx="35" cy="40" rx="8" ry="12" fill="rgba(255,255,255,0.4)" transform="rotate(-30 35 40)" style="pointer-events:none" />
        </svg>
    `;

    // Attach Listeners
    const legs = div.querySelectorAll('[data-pin]');
    legs.forEach(leg => {
        // Visual Hover Effects
        leg.addEventListener('mouseenter', () => {
            canvasManager.hoverPartPin(id, leg.getAttribute('data-pin'), leg, true);   // highlight, tooltip, can a wire end here?
        });

        leg.addEventListener('mouseleave', () => {
            canvasManager.hoverPartPin(id, leg.getAttribute('data-pin'), leg, false);
        });

        // Port Click
        leg.onmousedown = (e) => {
            e.stopPropagation();
            e.preventDefault();
            const pinName = leg.getAttribute('data-pin');
            const rect = leg.getBoundingClientRect();
            // We need a way to get local coords. CanvasManager should provide this or we use helper.
            // Using helper might require scale/pan access. keeping it simple:
            // passed canvasManager logic handles logic.

            canvasManager.handlePortClick(id, pinName, 'component_pin', rect, leg);
        };
    });

    // Drag Logic
    div.onmousedown = (e) => {
        if (e.target.tagName === 'path' && e.target.hasAttribute('data-pin')) return;
        e.stopPropagation();
        canvasManager.selectComponent(id);
        canvasManager.startComponentDrag(e, div); // Delegate back to manager
    };

    return div;
}

export function updateVisualLED(led) {
    const variants = ledColorMap[led.color] || { light: led.color, dark: led.color };
    const stop1 = document.getElementById(`stop1-${led.id}`);
    const stop2 = document.getElementById(`stop2-${led.id}`);
    const stop3 = document.getElementById(`stop3-${led.id}`);
    const base = document.getElementById(`led-base-${led.id}`);
    const label = led.div.querySelector('.led-label');

    if (stop1) stop1.setAttribute('stop-color', variants.light);
    if (stop2) stop2.setAttribute('stop-color', led.color);
    if (stop3) stop3.setAttribute('stop-color', variants.dark);
    if (base) base.setAttribute('fill', variants.dark);
    if (label) label.style.color = variants.light;
}

export function setLedState(led, action) {
    const variants = ledColorMap[led.color] || { light: led.color, dark: led.color };
    const base = document.getElementById(`led-base-${led.id}`);
    const svg = led.div.querySelector('svg');
    const stop1 = document.getElementById(`stop1-${led.id}`);
    const stop2 = document.getElementById(`stop2-${led.id}`);
    const stop3 = document.getElementById(`stop3-${led.id}`);

    if (action === 'ON') {
        svg.style.filter = `drop-shadow(0 0 15px ${led.color}) drop-shadow(0 0 30px ${led.color})`;
        svg.style.opacity = '1'; // Reset opacity (may have been set by PWM)
        if (base) base.setAttribute('fill', variants.light);
        if (stop1) stop1.setAttribute('stop-color', '#ffffff'); // White highlight
        if (stop2) stop2.setAttribute('stop-color', variants.light); // Bright color
        if (stop3) stop3.setAttribute('stop-color', led.color); // Base color
        led.isOn = true;
    } else if (action === 'OFF') {
        svg.style.filter = '';
        svg.style.opacity = '1'; // Reset opacity (may have been set by PWM)
        if (base) base.setAttribute('fill', variants.dark);
        if (stop1) stop1.setAttribute('stop-color', variants.light);
        if (stop2) stop2.setAttribute('stop-color', variants.dark);
        if (stop3) stop3.setAttribute('stop-color', variants.dark);
        led.isOn = false;
    } else if (action === 'TOGGLE') {
        setLedState(led, led.isOn ? 'OFF' : 'ON');
    }
}

/**
 * Set LED brightness for PWM-driven output.
 * This is an ADDITIONAL function — does NOT replace setLedState.
 * Used only when a GPIO driving this LED has active PWM.
 *
 * @param {object} led        — LED object from canvasManager.components
 * @param {number} brightness — 0.0 (fully off) to 1.0 (fully on)
 */
export function setLedBrightness(led, brightness) {
    const variants = ledColorMap[led.color] || { light: led.color, dark: led.color };
    const base = document.getElementById(`led-base-${led.id}`);
    const svg = led.div.querySelector('svg');
    const stop1 = document.getElementById(`stop1-${led.id}`);
    const stop2 = document.getElementById(`stop2-${led.id}`);
    const stop3 = document.getElementById(`stop3-${led.id}`);

    // Clamp brightness to 0.0–1.0
    const b = Math.max(0, Math.min(1, brightness));

    if (b === 0) {
        // Fully off — same as setLedState 'OFF'
        svg.style.filter = '';
        svg.style.opacity = '1';
        if (base) base.setAttribute('fill', variants.dark);
        if (stop1) stop1.setAttribute('stop-color', variants.light);
        if (stop2) stop2.setAttribute('stop-color', variants.dark);
        if (stop3) stop3.setAttribute('stop-color', variants.dark);
        led.isOn = false;
    } else {
        // Scale glow intensity with brightness
        const glowSize1 = Math.round(15 * b);
        const glowSize2 = Math.round(30 * b);
        svg.style.filter = `drop-shadow(0 0 ${glowSize1}px ${led.color}) drop-shadow(0 0 ${glowSize2}px ${led.color})`;
        svg.style.opacity = String(0.3 + 0.7 * b); // Minimum 30% opacity

        // Set LED colors — blend between ON and OFF states based on brightness
        if (base) base.setAttribute('fill', variants.light);
        if (stop1) stop1.setAttribute('stop-color', b > 0.5 ? '#ffffff' : variants.light);
        if (stop2) stop2.setAttribute('stop-color', variants.light);
        if (stop3) stop3.setAttribute('stop-color', led.color);
        led.isOn = b > 0;
    }
}


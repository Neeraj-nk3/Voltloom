/**
 * This file handles the Resistor component.
 * It creates the resistor using SVG and shows its pins.
 * It also changes color bands based on resistance value.
 */

import { assertSafeComponentId } from '../../shared/ids.js';
import { digitColors, multiplierColors } from '../../shared/colors.js';

export function createResistor(id, x, y, canvasManager) {
    assertSafeComponentId(id); // id is interpolated into markup below
    const div = document.createElement('div');
    div.id = id;
    div.className = 'part part--resistor';
    div.style.left = `${x}px`;
    div.style.top = `${y}px`;
    div.innerHTML = `
        <div class="resistor-label part-label">1 kΩ</div>
        <svg width="220" height="40" viewBox="0 0 559 84" xmlns="http://www.w3.org/2000/svg">
            <rect data-pin="1" data-tooltip="Terminal 1" x="0" y="0" width="100" height="84" fill="transparent" style="cursor:crosshair; pointer-events:all" />
            <line x1="0" y1="42" x2="149" y2="42" stroke="#ffffff" stroke-width="3" style="pointer-events:none" />
            
            <rect data-pin="2" data-tooltip="Terminal 2" x="459" y="0" width="100" height="84" fill="transparent" style="cursor:crosshair; pointer-events:all" />
            <line x1="399" y1="42" x2="559" y2="42" stroke="#ffffff" stroke-width="3" style="pointer-events:none" />
            
            <g id="resistor-body">
                <rect x="149" y="0" width="250" height="84" rx="20" fill="#E6D3A3"/>
            </g>
            <g id="color-bands">
                <rect id="band1_${id}" x="183" y="0" width="16" height="84" fill="#D9D9D9"/>
                <rect id="band2_${id}" x="219" y="0" width="20" height="84" fill="#D9D9D9"/>
                <rect id="band3_${id}" x="259" y="0" width="20" height="84" fill="#D9D9D9"/>
                <rect id="band4_${id}" x="319" y="0" width="20" height="84" fill="#D4AF37"/>
            </g>
        </svg>
    `;

    const terminals = div.querySelectorAll('rect[data-pin]');
    terminals.forEach(term => {
        term.onmouseenter = () => {
            canvasManager.hoverPartPin(id, term.getAttribute('data-pin'), term, true);   // highlight, tooltip, can a wire end here?
        };
        term.onmouseleave = () => {
            canvasManager.hoverPartPin(id, term.getAttribute('data-pin'), term, false);
        };

        term.onmousedown = (e) => {
            e.stopPropagation();
            e.preventDefault();
            const pinName = term.getAttribute('data-pin');
            const rect = term.getBoundingClientRect();
            canvasManager.handlePortClick(id, pinName, 'component_pin', rect, term);
        }
    });

    div.onmousedown = (e) => {
        if (e.target.hasAttribute('data-pin')) return;
        e.stopPropagation();
        canvasManager.selectComponent(id);
        canvasManager.startComponentDrag(e, div);
    };

    return div;
}

export function updateVisualResistor(res) {
    const totalVal = res.value * res.unit;
    const label = res.div.querySelector('.resistor-label');
    const unitText = res.unit === 1 ? 'Ω' : (res.unit === 1000 ? 'kΩ' : 'MΩ');
    if (label) label.innerText = `${res.value} ${unitText}`;

    const band1 = document.getElementById(`band1_${res.id}`);
    const band2 = document.getElementById(`band2_${res.id}`);
    const band3 = document.getElementById(`band3_${res.id}`);
    const band4 = document.getElementById(`band4_${res.id}`);

    if (totalVal === 0) {
        if (band1) band1.setAttribute('fill', digitColors[0]);
        if (band2) band2.setAttribute('fill', digitColors[0]);
        if (band3) band3.setAttribute('fill', digitColors[0]);
        if (band4) band4.setAttribute('fill', '#D4AF37');
        return;
    }

    if (isNaN(totalVal) || totalVal < 0) return;

    const exp = Math.floor(Math.log10(totalVal));
    const normalized = totalVal / Math.pow(10, exp);

    const digit1 = Math.floor(normalized);
    const digit2 = Math.floor((normalized - digit1) * 10);
    const multiplier = exp - 1;

    if (band1) band1.setAttribute('fill', digitColors[digit1] || '#D9D9D9');
    if (band2) band2.setAttribute('fill', digitColors[digit2] || '#D9D9D9');
    if (band3) band3.setAttribute('fill', multiplierColors[multiplier] || '#D9D9D9');
    if (band4) band4.setAttribute('fill', '#D4AF37');
}

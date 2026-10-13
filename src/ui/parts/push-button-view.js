/**
 * This file handles the Push Button component.
 * It creates a 4-pin tactile switch using SVG.
 * 
 * Pin Layout:
 *   Pin 1 (top-left)  ----  Pin 2 (top-right)     <- Always connected internally
 *   Pin 3 (bottom-left) -- Pin 4 (bottom-right)   <- Always connected internally
 * 
 * When pressed: Top row bridges to bottom row (all 4 pins connected)
 * 
 * This file does NOT handle simulation - only visual rendering.
 */

import { assertSafeComponentId } from '../../shared/ids.js';

/**
 * Creates a push button component on the canvas.
 * 
 * @param {string} id - Unique identifier for this button
 * @param {number} x - X position on canvas
 * @param {number} y - Y position on canvas
 * @param {number} buttonCount - Number of buttons on canvas (for label)
 * @param {object} canvasManager - Reference to the main canvas manager
 * @returns {HTMLDivElement} - The button's DOM element
 */
export function createPushButton(id, x, y, buttonCount, canvasManager) {
    assertSafeComponentId(id); // id is interpolated into markup below
    const label = `btn${buttonCount}`;
    const div = document.createElement('div');

    div.id = id;
    div.className = 'part part--button';
    div.style.left = `${x}px`;
    div.style.top = `${y}px`;

    // SVG for the push button - scaled down to fit nicely on canvas
    // Original viewBox was huge (2023x1921), we use a smaller portion
    div.innerHTML = `
        <div class="pushbutton-label part-label">Button ${buttonCount}</div>
        <svg width="200" height="130" viewBox="1010 1110 130 80" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <filter id="filter0_i_${id}" x="1051" y="1132" width="52" height="56" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
                    <feFlood flood-opacity="0" result="BackgroundImageFix"/>
                    <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>
                    <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
                    <feOffset dy="4"/>
                    <feGaussianBlur stdDeviation="2"/>
                    <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"/>
                    <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0"/>
                    <feBlend mode="normal" in2="shape" result="effect1_innerShadow"/>
                </filter>
                <filter id="filter1_d_${id}" x="1053" y="1138" width="48" height="48" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
                    <feFlood flood-opacity="0" result="BackgroundImageFix"/>
                    <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
                    <feOffset dy="4"/>
                    <feGaussianBlur stdDeviation="2"/>
                    <feComposite in2="hardAlpha" operator="out"/>
                    <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0"/>
                    <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow"/>
                    <feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow" result="shape"/>
                </filter>
                <clipPath id="clip0_${id}">
                    <rect x="1037.6" y="1117.9" width="79" height="79" rx="3" fill="white"/>
                </clipPath>
            </defs>
            
            <!-- Pin 1: Top-Left -->
            <rect data-pin="1" data-tooltip="${label}:Pin1" x="1017" y="1134" width="20" height="14" fill="transparent" style="cursor:crosshair; pointer-events:all" class="pin-hit-area"/>
            <path d="M1017 1138C1017 1137.45 1017.45 1137 1018 1137H1034V1144H1018C1017.45 1144 1017 1143.55 1017 1143V1138Z" fill="#D9D9D9" style="pointer-events:none"/>
            
            <!-- Pin 2: Top-Right -->
            <rect data-pin="2" data-tooltip="${label}:Pin2" x="1117" y="1134" width="20" height="14" fill="transparent" style="cursor:crosshair; pointer-events:all" class="pin-hit-area"/>
            <path d="M1137 1143C1137 1143.55 1136.55 1144 1136 1144H1120V1137H1136C1136.55 1137 1137 1137.45 1137 1138V1143Z" fill="#D9D9D9" style="pointer-events:none"/>
            
            <!-- Pin 3: Bottom-Left -->
            <rect data-pin="3" data-tooltip="${label}:Pin3" x="1017" y="1169" width="20" height="14" fill="transparent" style="cursor:crosshair; pointer-events:all" class="pin-hit-area"/>
            <path d="M1017 1173C1017 1172.45 1017.45 1172 1018 1172H1034V1179H1018C1017.45 1179 1017 1178.55 1017 1178V1173Z" fill="#D9D9D9" style="pointer-events:none"/>
            
            <!-- Pin 4: Bottom-Right -->
            <rect data-pin="4" data-tooltip="${label}:Pin4" x="1117" y="1169" width="20" height="14" fill="transparent" style="cursor:crosshair; pointer-events:all" class="pin-hit-area"/>
            <path d="M1137 1178C1137 1178.55 1136.55 1179 1136 1179H1120V1172H1136C1136.55 1172 1137 1172.45 1137 1173V1178Z" fill="#D9D9D9" style="pointer-events:none"/>
            
            <!-- Button Body -->
            <g clip-path="url(#clip0_${id})">
                <rect x="1037.6" y="1117.9" width="79" height="79" rx="3" fill="#464646"/>
                <rect x="1041.6" y="1122.9" width="70" height="70" rx="2" fill="#EAEAEA"/>
                <rect x="1037" y="1138" width="80" height="6" fill="#D1D1D1" fill-opacity="0.67"/>
                <rect x="1037" y="1173" width="80" height="6" fill="#D1D1D1" fill-opacity="0.67"/>
                
                <!-- Button Cap (the pressable part) -->
                <!-- Added ID to group for easier selection -->
                <g id="btn-cap-group-${id}" style="cursor: pointer;">
                    <g filter="url(#filter0_i_${id})">
                        <circle id="btn-outer-${id}" cx="1077" cy="1158" r="26" fill="#008000"/>
                    </g>
                    <g filter="url(#filter1_d_${id})">
                        <circle id="btn-inner-${id}" cx="1077" cy="1158" r="20" fill="#008000"/>
                        <circle cx="1077" cy="1158" r="19.75" stroke="black" stroke-width="0.5"/>
                    </g>
                </g>
                
                <!-- Corner screws -->
                <circle cx="1046.25" cy="1127.25" r="2.25" fill="black"/>
                <circle cx="1046.25" cy="1187.25" r="2.25" fill="black"/>
                <circle cx="1106.25" cy="1187.25" r="2.25" fill="black"/>
                <circle cx="1106.25" cy="1127.25" r="2.25" fill="black"/>
            </g>
            
            <!-- Internal wire connections (visual only) -->
            <path d="M1033.6 1134.9C1033.6 1134.35 1034.05 1133.9 1034.6 1133.9H1037.6V1147.9H1034.6C1034.05 1147.9 1033.6 1147.46 1033.6 1146.9V1134.9Z" fill="#D9D9D9" style="pointer-events:none"/>
            <path d="M1120 1147C1120 1147.55 1119.55 1148 1119 1148H1116V1134H1119C1119.55 1134 1120 1134.45 1120 1135V1147Z" fill="#D9D9D9" style="pointer-events:none"/>
            <path d="M1033.6 1169.9C1033.6 1169.35 1034.05 1168.9 1034.6 1168.9H1037.6V1182.9H1034.6C1034.05 1182.9 1033.6 1182.46 1033.6 1181.9V1169.9Z" fill="#D9D9D9" style="pointer-events:none"/>
            <path d="M1120 1182C1120 1182.55 1119.55 1183 1119 1183H1116V1169H1119C1119.55 1169 1120 1169.45 1120 1170V1182Z" fill="#D9D9D9" style="pointer-events:none"/>
        </svg>
    `;

    // Get all pin elements for interaction
    const pins = div.querySelectorAll('[data-pin]');
    pins.forEach(pin => {
        // Hover effect for pins - matches LED pin glow style
        pin.addEventListener('mouseenter', () => {
            canvasManager.hoverPartPin(id, pin.getAttribute('data-pin'), pin, true);   // highlight, tooltip, can a wire end here?
        });

        pin.addEventListener('mouseleave', () => {
            canvasManager.hoverPartPin(id, pin.getAttribute('data-pin'), pin, false);
        });

        // Click on pin to start/end wire
        pin.onmousedown = (e) => {
            e.stopPropagation();
            e.preventDefault();
            const pinName = pin.getAttribute('data-pin');
            const rect = pin.getBoundingClientRect();
            canvasManager.handlePortClick(id, pinName, 'component_pin', rect, pin);
        };
    });

    // Get the button cap element for press interaction
    // We target ONLY the green circle group for pressing
    const buttonCap = div.querySelector(`#btn-cap-group-${id}`);

    // Button press/release handling
    const handlePress = (e) => {
        // Don't trigger if clicking on pins
        if (e.target.hasAttribute('data-pin')) return;

        e.stopPropagation();

        // Notify the canvas manager that button is pressed
        if (canvasManager.onButtonPress) {
            canvasManager.onButtonPress(id, true);
        }
    };

    const handleRelease = () => {
        // Notify the canvas manager that button is released
        if (canvasManager.onButtonPress) {
            canvasManager.onButtonPress(id, false);
        }
    };

    if (buttonCap) {
        buttonCap.addEventListener('mousedown', handlePress);
        buttonCap.addEventListener('mouseup', handleRelease);
        buttonCap.addEventListener('mouseleave', handleRelease);
    }

    // Drag the component (when not clicking pins or pressing button cap)
    div.onmousedown = (e) => {
        // Don't drag if clicking pins
        if (e.target.hasAttribute('data-pin')) return;

        // Don't drag if clicking the pressable button cap (let handlePress handle it)
        if (e.target.closest(`#btn-cap-group-${id}`)) return;

        e.stopPropagation();
        canvasManager.selectComponent(id);
        canvasManager.startComponentDrag(e, div);
    };

    return div;
}

/**
 * Updates the visual state of the push button (pressed/released).
 * 
 * @param {object} button - The button component object
 * @param {boolean} isPressed - Whether the button is currently pressed
 */
export function setPushButtonPressed(button, isPressed) {
    const outerCircle = document.getElementById(`btn-outer-${button.id}`);
    const innerCircle = document.getElementById(`btn-inner-${button.id}`);

    if (isPressed) {
        // Pressed state: darker green, slight scale down
        if (outerCircle) outerCircle.setAttribute('fill', '#006400');
        if (innerCircle) {
            innerCircle.setAttribute('fill', '#006400');
            innerCircle.setAttribute('r', '18'); // Slightly smaller when pressed
        }
    } else {
        // Released state: normal green
        if (outerCircle) outerCircle.setAttribute('fill', '#008000');
        if (innerCircle) {
            innerCircle.setAttribute('fill', '#008000');
            innerCircle.setAttribute('r', '20'); // Normal size
        }
    }
}

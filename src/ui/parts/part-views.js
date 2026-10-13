/**
 * part-views.js — how each part type LOOKS and is edited in the browser
 *
 * Keyed by the same type names as the part registry (src/circuit/part-types.js), which holds what a
 * part IS (pins, electrical role, saved fields). This file holds what only matters on screen:
 * how to draw the part, where its pins are, which popup controls apply, how value/colour edits
 * change the drawing. CanvasManager asks this table instead of testing id prefixes.
 */

import { createLED, updateVisualLED } from './led-view.js';
import { createResistor, updateVisualResistor } from './resistor-view.js';
import { createPushButton } from './push-button-view.js';

const VIEWS = {
    led: {
        label: 'LED',
        size: [100, 200],                       // the unrotated drawing, in canvas units (pin anchors are measured inside it)
        pinName: (pin) => (pin === 'A' ? 'anode' : 'cathode'),
        startPosition: { x: 100, y: 300 },
        create: (id, x, y, index, canvas) => createLED(id, x, y, index, canvas),

        // Pin positions inside the 100x200 SVG, in canvas units (anchors for wires).
        portOffset: (pin) => (pin === 'A' ? [80, 155] : [35, 150]),

        // Which controls of the shared popup apply to this part.
        popup: { resistorControls: false, ledControls: true, flip: true },
        canFlip: true,

        setColor(component, color) {
            component.color = color;
            updateVisualLED(component);
        },
        afterRestore(component, data) {
            if (data.color) updateVisualLED(component);
        }
    },

    resistor: {
        label: 'Resistor',
        size: [220, 40],
        pinName: (pin) => `terminal ${pin}`,
        startPosition: { x: 50, y: 300 },
        create: (id, x, y, index, canvas) => createResistor(id, x, y, canvas),

        portOffset: (pin) => (pin === '1' ? [0, 20] : pin === '2' ? [220, 20] : [0, 0]),

        popup: { resistorControls: true, ledControls: false, flip: false },
        canFlip: false,

        /** Show this resistor's value in the popup's inputs. */
        syncPopup(component, { popupValue, popupUnit }) {
            if (popupValue) popupValue.value = component.value;
            if (popupUnit) popupUnit.value = component.unit;
        },
        setValue(component, value, unit) {
            component.value = parseFloat(value) || 0;
            component.unit = parseInt(unit) || 1;
            updateVisualResistor(component);
        },
        afterRestore(component) {
            updateVisualResistor(component);
        }
    },

    button: {
        label: 'Push button',
        size: [200, 130],
        pinName: (pin) => `pin ${pin}`,
        startPosition: { x: 100, y: 300 },
        create: (id, x, y, index, canvas) => createPushButton(id, x, y, index, canvas),

        // Push button pin positions (for the 200x130 SVG container).
        // viewBox="1010 1110 130 80" -> scale X = 200/130 = 1.538, Y = 130/80 = 1.625.
        // Anchors sit at the exact metal pin tips for a clean visual connection:
        //   pin 1: viewBox(7, 31) -> (11, 50)    pin 2: viewBox(127, 31) -> (195, 50)
        //   pin 3: viewBox(7, 66) -> (11, 107)   pin 4: viewBox(127, 66) -> (195, 107)
        portOffset: (pin) => ({ '1': [11, 50], '2': [195, 50], '3': [11, 107], '4': [195, 107] }[pin] || [0, 0]),

        popup: { resistorControls: false, ledControls: false, flip: false },
        canFlip: false
    }
};

/** The view description for a registry type name ('led', 'resistor', 'button'), or null. */
export function getPartView(type) {
    return Object.prototype.hasOwnProperty.call(VIEWS, type) ? VIEWS[type] : null;
}

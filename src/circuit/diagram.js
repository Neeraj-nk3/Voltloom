/**
 * diagram.js — the "diagram.json" view of a circuit (the second editor tab)
 *
 * A Wokwi-style description of the parts and their connections. Pure function: no DOM, no globals.
 * The output format is part of the product (it is shown to the user) and is pinned by tests.
 */

import { partTypeOf, indexAmongType } from './part-types.js';

// Names the MicroPython runtime the exported diagram was made for: the version and build date of the bundled runtimes/micropython/micropython.wasm
// (tests/unit/circuit/diagram-runtime-version.test.js fails if the two ever disagree).
export const PICO_ENV = 'micropython-20251210-v1.27.0';

/**
 * @param {object[]} components — canvas components ({id, x, y, value?, ...})
 * @param {object[]} wires — canvas wires ({start, end}), nodes as in project files
 * @param {object[]} picoPins — the board pin table ([{pin, label, type}, ...])
 * @returns {object} the diagram object (callers JSON.stringify it)
 */
export function buildDiagram(components, wires, picoPins) {
    const parts = [
        { type: 'raspberry-pi-pico', id: 'pico', top: 0, left: 0, attrs: { env: PICO_ENV }, connections: [] }
    ];

    const friendlyPartId = (component) => {
        const descriptor = partTypeOf(component);
        return descriptor ? `${descriptor.diagram.idPrefix}${indexAmongType(components, component)}` : null;
    };

    components.forEach((c) => {
        const descriptor = partTypeOf(c);
        if (!descriptor) return;
        parts.push({
            type: descriptor.diagram.type,
            id: friendlyPartId(c),
            top: c.y,
            left: c.x,
            attrs: descriptor.diagram.attrs(c),
            connections: []
        });
    });

    const friendlyNodeId = (node) => {
        if (node.nodeType === 'gpio') {
            const pinDef = picoPins.find((p) => p.pin == node.pin);
            return pinDef ? `pico:${pinDef.label}` : null;
        }
        if (node.nodeType === 'component_pin') {
            const component = components.find((comp) => comp.id === node.componentId);
            const partId = component ? friendlyPartId(component) : null;
            return partId ? `${partId}:${node.pin}` : null;
        }
        return null;
    };

    wires.forEach((w) => {
        const srcId = friendlyNodeId(w.start);
        const dstId = friendlyNodeId(w.end);
        if (srcId && dstId) {
            const [srcPartId, srcPin] = srcId.split(':');
            const [dstPartId, dstPin] = dstId.split(':');
            const srcPart = parts.find((p) => p.id === srcPartId);
            const dstPart = parts.find((p) => p.id === dstPartId);
            if (srcPart) srcPart.connections.push(`${srcPin}:${dstId}`);
            if (dstPart) dstPart.connections.push(`${dstPin}:${srcId}`);
        }
    });

    return { version: 1, author: 'Anonymous', editor: 'Voltloom', parts, dependencies: {} };
}

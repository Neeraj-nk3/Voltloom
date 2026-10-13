/**
 * This file handles connecting wires.
 * It lets you click pins to start and finish a wire.
 * It also checks if the connection is allowed (valid).
 */

import { pathFromPoints, createWireElement } from './wire-view.js';
import { routeWires } from './wire-router.js';
import { routeFromPoints, adaptRoute, crossesAny, moveSegment, moveBend, insertBend, cleanRoute, segmentMovable, orthogonalThrough } from './wire-edit.js';

// Wire thickness in canvas units (thin, like Wokwi); the hover and selected states are a little thicker.
export const WIRE_WIDTH = '4';
export const WIRE_WIDTH_HOT = '6';
import { LEFT_PINS, RIGHT_PINS } from '../../circuit/board-pin-layout.js';
import { addWire, removeWire, validateWire, syncWires } from '../../circuit/wire-registry.js';
import { printError } from '../panels/serial-output.js';
import { partTypeOf } from '../../circuit/part-types.js';
import { nextUniqueId } from '../../shared/ids.js';

import { validateNewWire } from '../../circuit/circuit-validator.js';

export class WireInteractionManager {
    constructor(canvasManager) {
        this.canvasManager = canvasManager;
        this.wireStartNode = null;
        this.tempWireInfo = null;
        this.selectedWireId = null;
    }

    /**
     * Whether the wire being drawn may end on this pin: 'valid', 'invalid' (polarity, a duplicate, or a rule of the
     * wire registry) or 'self' (its own start). Used to colour the pin under the pointer before the click.
     */
    targetState(portInfo) {
        if (!this.wireStartNode) return null;
        if (this.isSameNode(this.wireStartNode, portInfo)) return 'self';
        if (!this.isValidConnection(this.wireStartNode, portInfo)) return 'invalid';
        if (!validateNewWire({ start: this.wireStartNode, end: portInfo }, this.canvasManager.wires)) return 'invalid';
        if (!validateWire(this.wireStartNode, portInfo).valid) return 'invalid';
        return 'valid';
    }

    handlePortClick(portInfo, element) {
        if (this.wireStartNode) {
            // Finishing Wire

            // Check for Self-Connection / Same Node
            if (this.isSameNode(this.wireStartNode, portInfo)) {
                this.cancelWire();
                return;
            }

            // Validation Check
            if (this.isValidConnection(this.wireStartNode, portInfo)) {
                this.finishWire(portInfo);
            } else {
                printError('Invalid connection: Electrical theory violation (check polarity).');
                this.cancelWire();
                this.canvasManager.flashHint('Those pins cannot be connected: the polarity would be wrong (anode to ground, or cathode to power).');
                return;
            }
        } else {
            // Starting Wire
            this.startWire(portInfo);
        }
    }

    isSameNode(n1, n2) {
        if (n1.nodeType !== n2.nodeType) return false;
        if (n1.nodeType === 'component_pin') return n1.componentId === n2.componentId && n1.pin === n2.pin;
        if (n1.nodeType === 'gpio') return n1.pin === n2.pin;
        return false;
    }

    isValidConnection(start, end) {
        const getPinType = (node) => {
            if (node.nodeType === 'gpio') {
                const allPins = [...LEFT_PINS, ...RIGHT_PINS];
                const pinDef = allPins.find(p => p.pin === node.pin);
                if (pinDef) return pinDef.type;
                return 'GPIO';
            }
            if (node.nodeType === 'component_pin') {
                const comp = this.canvasManager.components.find(c => c.id === node.componentId);
                // comp might be undefined if deleted mid-wire?
                if (!comp) return 'Unknown';

                // 'Anode' | 'Cathode' | 'Passive' (resistor and button pins connect to anything) | 'Unknown'
                const descriptor = partTypeOf(comp);
                if (descriptor) return descriptor.pinKind(node.pin);
            }
            return 'Unknown';
        };

        const type1 = getPinType(start);
        const type2 = getPinType(end);

        // Explicitly allow Passive connections (Resistors to Anything)
        if (type1 === 'Passive' || type2 === 'Passive') return true;

        if ((type1 === 'Anode' && type2 === 'Ground') || (type2 === 'Anode' && type1 === 'Ground')) return false;
        if ((type1 === 'Cathode' && type2 === 'Power') || (type2 === 'Cathode' && type1 === 'Power')) return false;
        return true;
    }

    startWire(portInfo) {
        this.wireStartNode = portInfo;
        this.waypoints = [];             // corners the user clicks on the canvas while drawing (Wokwi style)

        // Create Temp Path: dashed and copper, so a wire that is not made yet looks unfinished
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("stroke", "#f0aa76");
        path.setAttribute("stroke-width", WIRE_WIDTH);
        path.setAttribute("stroke-dasharray", "8 6");
        path.setAttribute("fill", "none");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        path.setAttribute("d", `M ${portInfo.x} ${portInfo.y}`);
        path.setAttribute("class", "wire wire--temp");
        path.setAttribute("marker-start", "url(#wire-end)");

        this.canvasManager.wireLayer.appendChild(path);
        this.tempWireInfo = { pathElement: path };
        this.canvasManager.markWireSource(portInfo, true);
        this.canvasManager.simulationArea.classList.add('is-wiring');
        this.canvasManager.refreshHint();
    }

    updateTempWire(e) {
        if (!this.wireStartNode || !this.tempWireInfo) return;

        // Prevent DOM thrashing during mouse move: at most one update per frame
        if (this._updatePending) return;
        this._updatePending = true;

        requestAnimationFrame(() => {
            this._updatePending = false;
            if (!this.wireStartNode || !this.tempWireInfo) return;
            this._pointer = this.canvasManager.getLocalCoords(e.clientX, e.clientY);
            this.redrawPreview();
        });
    }

    /** The wire being drawn: from its pin, through the corners placed so far, to the pointer, all square. */
    redrawPreview() {
        if (!this.wireStartNode || !this.tempWireInfo) return;
        const pointer = this._pointer || this.wireStartNode;
        const dir = this.canvasManager.pinDirection(this.wireStartNode);
        const pts = orthogonalThrough([{ x: this.wireStartNode.x, y: this.wireStartNode.y }, ...(this.waypoints || []), pointer], dir);
        this.tempWireInfo.pathElement.setAttribute("d", pathFromPoints(pts));
    }

    /** A click on empty canvas while drawing: fix a corner there (snapped to a 10-unit grid), like Wokwi. */
    addWaypoint(at) {
        if (!this.wireStartNode) return;
        const snap = (v) => Math.round(v / 10) * 10;
        this.waypoints.push({ x: snap(at.x), y: snap(at.y) });
        this.redrawPreview();
        this.canvasManager.refreshHint();
    }

    /** Backspace while drawing: take back the last corner. */
    removeLastWaypoint() {
        if (!this.wireStartNode || !this.waypoints.length) return false;
        this.waypoints.pop();
        this.redrawPreview();
        this.canvasManager.refreshHint();
        return true;
    }

    cancelWire() {
        this.waypoints = [];
        if (this.wireStartNode) this.canvasManager.markWireSource(this.wireStartNode, false);
        if (this.tempWireInfo && this.tempWireInfo.pathElement) {
            this.tempWireInfo.pathElement.remove();
        }
        this.wireStartNode = null;
        this.tempWireInfo = null;
        this.canvasManager.simulationArea.classList.remove('is-wiring');
        this.canvasManager.refreshHint();
    }

    finishWire(endPort) {
        if (!this.wireStartNode) return;

        // Completely prevent duplicate wires
        const newWire = { start: this.wireStartNode, end: endPort };
        if (!validateNewWire(newWire, this.canvasManager.wires)) {
            this.cancelWire();
            this.canvasManager.flashHint('Those two pins are already connected by a wire.', 'idle');
            return;
        }

        // Validate connection (wire registry rules)
        const validation = validateWire(this.wireStartNode, endPort);
        if (!validation.valid) {
            printError(validation.reason);
            this.cancelWire();
            this.canvasManager.flashHint(validation.reason);
            return;
        }

        // Create the permanent wire. Corners clicked while drawing become its shape (kept, Wokwi style); with no
        // corners it is routed automatically.
        this.canvasManager.markWireSource(this.wireStartNode, false);
        const corners = this.waypoints || [];
        this.waypoints = [];
        const made = this.createWire(this.wireStartNode, endPort, undefined, corners);

        // Cleanup Temp
        if (this.tempWireInfo && this.tempWireInfo.pathElement) this.tempWireInfo.pathElement.remove();

        this.wireStartNode = null;
        this.tempWireInfo = null;
        this.canvasManager.simulationArea.classList.remove('is-wiring');
        this.canvasManager.refreshHint();

        // Notify changes?
        // Logic from main.js called updateCircuit() and updateDiagramEditor()
        if (this.canvasManager.onCircuitChange) this.canvasManager.onCircuitChange();
    }

    /**
     * @param {string} [savedId]  the id a saved project gave this wire (kept if it is free, so identity survives a reload)
     * @param {Array<{x,y}>} [corners]  corners the user placed while drawing: the wire keeps that shape
     */
    createWire(start, end, savedId, corners = []) {
        const taken = (candidate) => this.canvasManager.wires.some((w) => w.id === candidate);
        const id = savedId && !taken(savedId) ? savedId : nextUniqueId('wire', taken);

        // Data Object
        const wire = {
            id: id,
            start: start,
            end: end,
            color: '#3b82f6',          // new wires: blue reads on the green board and on both canvas themes
            flipped: false,
            pathElement: null // Will be set by helper
        };

        // Visual Element (using helper from wire-view.js)
        const path = createWireElement(wire, this.canvasManager.wireLayer);

        // Add Listeners
        const getPortCoords = this.canvasManager.getPortCoords.bind(this.canvasManager);
        const startCoords = getPortCoords(start) || start;
        const endCoords = getPortCoords(end) || end;
        path.setAttribute("d", pathFromPoints([startCoords, endCoords]));     // replaced by the routed path below

        path.onclick = (e) => {
            e.stopPropagation();
            // Wires are drawn above the board, and many run along its pin columns. A click on a pin that a wire
            // happens to cross means the pin, not the wire.
            const pin = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el !== path && el.hasAttribute && el.hasAttribute('data-is-port'));
            if (pin) {
                pin.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: e.clientX, clientY: e.clientY }));
                return;
            }
            this.selectWire(wire);
        };

        // Double-click a selected wire to add a bend there, which can then be dragged into a step
        path.ondblclick = (e) => {
            e.stopPropagation();
            if (this.selectedWireId !== id) return;
            this.insertBendAt(wire, this.canvasManager.getLocalCoords(e.clientX, e.clientY));
        };

        path.onmouseenter = () => {
            if (this.selectedWireId !== id) path.setAttribute("stroke-width", WIRE_WIDTH_HOT);
        };
        path.onmouseleave = () => {
            if (this.selectedWireId !== id) path.setAttribute("stroke-width", WIRE_WIDTH);
        };

        this.canvasManager.wires.push(wire);
        if (corners.length) {
            const pts = orthogonalThrough([startCoords, ...corners, endCoords], this.canvasManager.pinDirection(start));
            const route = routeFromPoints(pts);
            if (route && route.points.length >= 3) wire.route = cleanRoute(route);
        }

        // Register with the wire registry
        addWire(wire);

        // Keep connection graph in sync
        syncWires(this.canvasManager.wires);
        this.updateWires();              // every wire is routed again, so the new one finds its own lane
        this.canvasManager.refreshHint();

        return wire;
    }

    selectWire(wire) {
        // Deselect components first: that also clears the wire selection, which is set again just below
        this.canvasManager.selectComponent(null);
        this.selectedWireId = wire.id;

        // The selected wire is drawn thicker with a soft copper halo
        this.canvasManager.wires.forEach(w => {
            w.pathElement.classList.toggle('is-selected', w.id === wire.id);
            w.pathElement.setAttribute("stroke-width", w.id === wire.id ? WIRE_WIDTH_HOT : WIRE_WIDTH);
        });

        // Show Popup (delegated to CanvasManager because it owns the popup UI)
        this.canvasManager.showWirePopup(wire);
        this.renderHandles();
    }

    deleteWire(id) {
        const wire = this.canvasManager.wires.find(w => w.id === id);
        if (!wire) return;

        wire.pathElement.remove();
        this.canvasManager.wires = this.canvasManager.wires.filter(w => w.id !== id);

        // Remove from the wire registry and trigger the cleanup callback
        removeWire(id);
        syncWires(this.canvasManager.wires);

        if (this.selectedWireId === id) {
            this.selectedWireId = null;
            this.canvasManager.hidePopup();
        }
        this.updateWires();              // the lane it used is free again (and its handles go)
        this.canvasManager.refreshHint();

        if (this.canvasManager.onCircuitChange) this.canvasManager.onCircuitChange();
    }

    /**
     * Route every wire again, together (see wire-router.js): straight segments and right angles, around the board and
     * the parts, each wire in its own lane. Called whenever a wire or a part changes.
     *
     * A wire the user routed by hand (wire.route, see wire-edit.js) keeps its shape: its ends follow its pins and the
     * automatic wires are routed around it. If its shape can no longer be kept (a part now sits on it, or its pins moved
     * so that it would bend back into a part), it quietly returns to automatic routing; the connection never changes.
     */
    updateWires() {
        cancelAnimationFrame(this._routeFrame);
        this._routeFrame = null;
        const { requests, obstacles, partObstacles } = this.canvasManager.routingInput();
        const byId = new Map(requests.map((r) => [r.id, r]));
        const fixed = [];
        for (const w of this.canvasManager.wires) {
            const req = byId.get(w.id);
            if (!req) continue;
            if (!w.route && w.savedRoute) {                 // a hand-made shape from a saved project: re-attach it
                w.route = routeFromPoints([{ x: req.start.x, y: req.start.y }, ...w.savedRoute, { x: req.end.x, y: req.end.y }]);
                delete w.savedRoute;
            }
            if (!w.route) continue;
            const kept = adaptRoute(w.route, req.start, req.end);
            if (!kept || crossesAny(kept, partObstacles)) { w.route = null; continue; }
            w.route = kept;
            fixed.push({ id: w.id, points: kept.points });
            byId.delete(w.id);
        }
        const routes = routeWires([...byId.values()], obstacles, { fixed });
        for (const w of this.canvasManager.wires) {
            const points = routes.get(w.id);
            if (!points || !w.pathElement) continue;
            w.points = points;                              // the shape on screen: where editing starts from
            w.pathElement.setAttribute("d", pathFromPoints(points));
        }
        this.renderHandles();
    }

    // ───────── Editing a wire's route by hand ─────────

    /** Pin directions of a wire's two ends (the way it must leave each pin). */
    wireDirs(wire) {
        return { startDir: this.canvasManager.pinDirection(wire.start), endDir: this.canvasManager.pinDirection(wire.end) };
    }

    /** The wire's current route, made editable (its manual route, or the router's last result). */
    editableRoute(wire) {
        return wire.route || (wire.points ? routeFromPoints(wire.points) : null);
    }

    /** Show the drag handles of the selected wire: its bends, and the middle of every segment that can move. */
    renderHandles() {
        const layer = this.canvasManager.wireLayer;
        if (!layer) return;
        let group = layer.querySelector('#wire-handles');
        if (!group) {
            group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            group.id = 'wire-handles';
        }
        layer.appendChild(group);                          // always last, so the handles sit above every wire
        group.replaceChildren();
        const wire = this.canvasManager.wires.find((w) => w.id === this.selectedWireId);
        const route = wire && this.editableRoute(wire);
        if (!route) return;

        const scale = this.canvasManager.view.scale;
        const ns = 'http://www.w3.org/2000/svg';
        const { points, orients } = route;
        // the middle of each segment that may move: drag it across to shift that stretch of wire
        for (let i = 0; i < orients.length; i++) {
            if (!segmentMovable(route, i)) continue;
            const a = points[i], b = points[i + 1];
            if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) < 28 / scale) continue;     // too short to need a handle
            const size = 9 / scale;
            const h = document.createElementNS(ns, 'rect');
            h.setAttribute('x', (a.x + b.x) / 2 - size / 2);
            h.setAttribute('y', (a.y + b.y) / 2 - size / 2);
            h.setAttribute('width', size);
            h.setAttribute('height', size);
            h.setAttribute('rx', 2 / scale);
            h.setAttribute('class', `wire-handle wire-handle--segment wire-handle--${orients[i]}`);
            h.addEventListener('mousedown', (e) => this.startHandleDrag(e, wire, { segment: i }));
            group.appendChild(h);
        }
        // every bend (never the pins): drag it anywhere, the wire stays square
        for (let i = 1; i < points.length - 1; i++) {
            const c = document.createElementNS(ns, 'circle');
            c.setAttribute('cx', points[i].x);
            c.setAttribute('cy', points[i].y);
            c.setAttribute('r', 5.5 / scale);
            c.setAttribute('class', 'wire-handle wire-handle--bend');
            c.addEventListener('mousedown', (e) => this.startHandleDrag(e, wire, { bend: i }));
            group.appendChild(c);
        }
    }

    /** Drag a handle. Only the route changes: the wire's pins, its connection and every part stay where they are. */
    startHandleDrag(e, wire, target) {
        if (e.button !== 0) return;
        e.stopPropagation();                               // not a pan, not a deselect, not a part drag
        e.preventDefault();
        const base = this.editableRoute(wire);
        if (!base) return;
        const dirs = {};                                   // shapes are free, as in Wokwi: only squareness is kept
        const { partObstacles } = this.canvasManager.routingInput();
        const startX = e.clientX, startY = e.clientY;
        const SNAP = 5;
        const snap = (v) => Math.round(v / SNAP) * SNAP;
        let current = base;
        this.canvasManager.simulationArea.classList.add('is-editing-wire');

        const move = (ev) => {
            const scale = this.canvasManager.view.scale;
            const dx = snap((ev.clientX - startX) / scale);
            const dy = snap((ev.clientY - startY) / scale);
            let next;
            if (target.segment !== undefined) {
                const delta = base.orients[target.segment] === 'h' ? dy : dx;
                next = delta === 0 ? base : moveSegment(base, target.segment, delta, dirs);
            } else {
                next = dx === 0 && dy === 0 ? base : moveBend(base, target.bend, dx, dy, dirs);
            }
            // a route may not pass through a part: at such a position the wire keeps its last good shape
            if (!next || crossesAny(next, partObstacles)) return;
            current = next;
            wire.route = current;
            wire.points = current.points;
            wire.pathElement.setAttribute('d', pathFromPoints(current.points));
            this.renderHandles();
        };
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            this.canvasManager.simulationArea.classList.remove('is-editing-wire');
            if (current !== base) {
                wire.route = cleanRoute(current);
                this.updateWires();                        // the automatic wires make way for the new shape
                if (this.canvasManager.onCircuitChange) this.canvasManager.onCircuitChange();   // saved with the project
            }
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    }

    /** Add a bend to a wire at a point (local units), on the movable segment nearest to it. */
    insertBendAt(wire, at) {
        const route = this.editableRoute(wire);
        if (!route) return;
        let best = -1, bestDist = Infinity;
        for (let i = 0; i < route.orients.length; i++) {
            if (!segmentMovable(route, i)) continue;
            const a = route.points[i], b = route.points[i + 1];
            const d = route.orients[i] === 'h'
                ? (Math.min(a.x, b.x) <= at.x && at.x <= Math.max(a.x, b.x) ? Math.abs(at.y - a.y) : Infinity)
                : (Math.min(a.y, b.y) <= at.y && at.y <= Math.max(a.y, b.y) ? Math.abs(at.x - a.x) : Infinity);
            if (d < bestDist) { bestDist = d; best = i; }
        }
        if (best < 0) return;
        wire.route = insertBend(route, best, { x: Math.round(at.x), y: Math.round(at.y) });
        wire.points = wire.route.points;
        this.renderHandles();
    }

    /** The same, at most once per frame (while a part is being dragged). */
    scheduleUpdateWires() {
        if (this._routeFrame) return;
        this._routeFrame = requestAnimationFrame(() => { this._routeFrame = null; this.updateWires(); });
    }
}

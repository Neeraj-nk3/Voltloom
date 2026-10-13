/**
 * This file controls the main drawing area (canvas).
 * It manages the components, wires, zooming and panning, and the floating properties card.
 *
 * It does NOT handle the simulation logic. The maths of zoom, fit, pin positions and floating-card placement is in
 * geometry.js (pure functions with unit tests); this file applies it to the page.
 */

import { WireInteractionManager } from './wire-interaction-manager.js';
import { addWireDefs } from './wire-view.js';
import { LEFT_PINS, RIGHT_PINS } from '../../circuit/board-pin-layout.js';
import { getPartView } from '../parts/part-views.js';
import { getPartType, partTypeOf, partsOfType, indexAmongType } from '../../circuit/part-types.js';
import { readoutText } from '../../electrical/readout.js';
import { nextUniqueId } from '../../shared/ids.js';
import { syncWires } from '../../circuit/wire-registry.js';
import {
    clampScale, wheelDeltaPx, wheelZoomFactor, zoomAt, fitView, isVisible, unionBounds,
    transformPortOffset, partBounds, placeFloating, spawnPosition
} from './geometry.js';
import { showTip, hideTip } from '../tooltip.js';
import { renderHint } from '../hint.js';
import { readPref, writePref } from '../storage.js';
// The board drawing. Importing it as a URL makes the build include the file (a plain fetch of a
// root-level file works in the dev server but the file never reached dist/).
import boardSvgUrl from '../assets/pico-board.svg?url';

const BOARD_WIDTH = 400;                    // local units; the board SVG scales to this width
const BUTTON_ZOOM_STEP = 1.2;
const FIT_PADDING = 40;
const GUTTER = 26;                          // local units between the board's edge and the wires that leave its pins

export class CanvasManager {
    constructor(containerElement, simulationAreaElement) {
        this.container = containerElement;
        this.simulationArea = simulationAreaElement;

        // State
        this.components = [];
        this.wires = [];
        this.wireManager = new WireInteractionManager(this);

        // View: where the container is (x, y in pixels from the corner of the canvas area) and how big (scale).
        this.view = { scale: 1, x: 0, y: 0 };
        this.boardHeight = 0;
        this.pendingFit = false;        // a fit was wanted while the canvas had no size (hidden pane)
        this.userView = false;          // the viewer has chosen a viewport (saved, or zoomed/panned): never override it silently
        this.isPanning = false;
        this._saveTimer = null;

        // UI References (set later)
        this.wireLayer = null;
        this.componentPopup = null;
        this.popupTarget = null;        // { kind: 'component' | 'wire', id }
        this.selectedComponentId = null;
        this.hintEl = null;
        this._hintFlash = null;

        // Callbacks
        this.onCircuitChange = null;
        this.electrical = null;       // last solved circuit (set by the simulator; used for the readout)
        // Callback for button press events (connected by SimulatorBridge)
        this.onButtonPress = null;

        this.gpToElementMap = {};
        this.pinElements = {};          // physical pin number -> its drawing on the board
        this.pinClusters = {};          // physical pin number -> every shape that makes up that pad
        this._pinCoords = {};           // physical pin number -> centre in local units (the board never moves)
    }

    /** Current zoom factor (1 = 100%). */
    get scale() { return this.view.scale; }

    init() {
        this.hintEl = document.getElementById('canvas-hint');
        this.setupWireLayer();
        this.setupEventListeners();
        this.restoreSavedView();
        this.setGrid(readPref('grid') === true, { save: false });
        this.refreshHint();
    }

    /** The optional placement grid (off by default; a per-viewer preference). */
    setGrid(on, { save = true } = {}) {
        this.gridOn = !!on;
        if (this.simulationArea) this.simulationArea.classList.toggle('show-grid', this.gridOn);
        const button = document.getElementById('grid-toggle-btn');
        if (button) button.setAttribute('aria-pressed', String(this.gridOn));
        if (save) writePref('grid', this.gridOn);
    }

    setupWireLayer() {
        if (!this.container) return;
        this.wireLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        this.wireLayer.id = "wire-layer";
        Object.assign(this.wireLayer.style, {
            position: "absolute", top: "0", left: "0", width: "100%", height: "100%",
            overflow: "visible", zIndex: "10", pointerEvents: "none"
        });
        addWireDefs(this.wireLayer);
        this.container.appendChild(this.wireLayer);
    }

    async loadBoardSVG() {
        const state = document.getElementById('canvas-state');
        try {
            const response = await fetch(boardSvgUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const text = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, "text/html");
            const svg = doc.querySelector("svg");
            if (!svg) throw new Error('the file has no drawing in it');

            svg.setAttribute("width", "100%");
            svg.setAttribute("height", "100%");
            svg.style.overflow = "visible";

            if (this.container) {
                this.container.style.width = `${BOARD_WIDTH}px`;
                this.container.innerHTML = "";
                if (this.wireLayer) this.container.appendChild(this.wireLayer);
                this.container.appendChild(svg);
                this.setupPins(svg);
                this.boardHeight = this.container.offsetHeight;
            }
            if (state) state.hidden = true;
        } catch (err) {
            console.error("Failed to load SVG", err);
            if (state) {
                state.hidden = false;
                state.innerHTML = '<div class="empty empty--error"><span class="empty__title">The board drawing could not be loaded</span><p>Check your connection and reload the page. Your project is not affected.</p></div>';
            }
        }
    }

    // --------------------------------------------------
    // Pin Setup
    // We fix issues where some pins were hard to click.
    // --------------------------------------------------
    setupPins(svg) {
        // Fix overlay blocking events
        svg.querySelectorAll("circle, path").forEach(el => {
            const fill = el.getAttribute("fill");
            if (["#333333", "#363732", "#3B3D37", "#2A2D2E", "#DBDDDA", "#363A44"].includes(fill) || fill === "#006837") {
                el.style.pointerEvents = "none";
            }
        });

        const paths = Array.from(svg.querySelectorAll("path, rect"));
        const getFill = (el) => el.getAttribute("fill") || el.style.fill;
        const candidates = [];

        paths.forEach(el => {
            const fill = getFill(el);
            if (fill !== "#958863") return;

            const bbox = el.getBBox();
            const ctm = el.getCTM();
            let cx, cy;
            if (ctm) {
                const localCx = bbox.x + bbox.width / 2;
                const localCy = bbox.y + bbox.height / 2;
                cx = ctm.a * localCx + ctm.c * localCy + ctm.e;
                cy = ctm.b * localCx + ctm.d * localCy + ctm.f;
            } else {
                cx = bbox.x + bbox.width / 2;
                cy = bbox.y + bbox.height / 2;
            }

            candidates.push({ el, cx, cy });
        });

        const leftCandidates = candidates.filter(c => c.cx < 70);
        const rightCandidates = candidates.filter(c => c.cx >= 70);

        const createClusters = (list) => {
            list.sort((a, b) => a.cy - b.cy);
            const clusters = [];
            if (list.length === 0) return clusters;
            const Y_TOLERANCE = 8;
            let currentCluster = [list[0]];
            for (let i = 1; i < list.length; i++) {
                if (Math.abs(list[i].cy - currentCluster[0].cy) < Y_TOLERANCE) {
                    currentCluster.push(list[i]);
                } else {
                    clusters.push(currentCluster);
                    currentCluster = [list[i]];
                }
            }
            clusters.push(currentCluster);
            return clusters;
        };

        const leftClusters = createClusters(leftCandidates);
        const rightClusters = createClusters(rightCandidates);

        const bindPinToCluster = (cluster, pinInfo, side) => {
            if (!pinInfo) return;
            this.pinElements[pinInfo.pin] = cluster[0].el;
            this.pinClusters[pinInfo.pin] = cluster.map((c) => c.el);
            if (pinInfo.label.startsWith("GP")) {
                const gpNum = pinInfo.label.replace("GP", "");
                this.gpToElementMap[gpNum] = cluster[0].el;
            }

            cluster.forEach(item => {
                const element = item.el;
                element.style.pointerEvents = "all";
                element.style.cursor = "crosshair";
                element.setAttribute('data-is-port', 'true');
                element.setAttribute('data-pin-label', pinInfo.label);

                element.addEventListener("mouseenter", () => {
                    const port = { nodeType: 'gpio', pin: pinInfo.pin };
                    const target = this.wireManager.targetState(port);
                    this.setPinState(cluster.map((c) => c.el), target === 'valid' ? 'valid' : target === 'invalid' ? 'invalid' : 'hot');
                    const meta = target === 'valid' ? 'Click to connect' : target === 'invalid' ? 'Cannot connect here' : `Pin ${pinInfo.pin} · ${pinInfo.type}`;
                    showTip(element.getBoundingClientRect(), pinInfo.label, { meta, mono: true, side });
                });

                element.addEventListener("mouseleave", () => {
                    this.setPinState(cluster.map((c) => c.el), null);
                    hideTip();
                });

                element.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const rect = element.getBoundingClientRect();
                    const center = this.getLocalCoords(rect.left + rect.width / 2, rect.top + rect.height / 2);

                    this.wireManager.handlePortClick({
                        nodeType: 'gpio',
                        pin: pinInfo.pin,
                        gpNum: pinInfo.label.startsWith("GP") ? pinInfo.label.replace("GP", "") : null,
                        x: center.x,
                        y: center.y
                    }, element);
                });
            });
        };

        // Bind Left
        leftClusters.forEach((cluster, i) => {
            if (i < LEFT_PINS.length) bindPinToCluster(cluster, LEFT_PINS[i], 'left');
        });

        // Bind Right (with orphan logic)
        if (rightClusters.length > RIGHT_PINS.length) {
            const leftYs = leftClusters.map(c => c[0].cy);
            let pinIndex = 0;
            rightClusters.forEach((cluster) => {
                const clusterY = cluster[0].cy;
                const hasLeftMatch = leftYs.some(leftY => Math.abs(leftY - clusterY) < 10);
                if (hasLeftMatch && pinIndex < RIGHT_PINS.length) {
                    bindPinToCluster(cluster, RIGHT_PINS[pinIndex], 'right');
                    pinIndex++;
                }
            });
        } else {
            rightClusters.forEach((cluster, i) => {
                if (i < RIGHT_PINS.length) bindPinToCluster(cluster, RIGHT_PINS[i], 'right');
            });
        }
    }

    // --------------------------------------------------
    // Interaction Helpers
    // --------------------------------------------------

    /** The canvas area's box on screen, and its size. */
    areaRect() {
        const rect = this.simulationArea.getBoundingClientRect();
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    }

    /** Page pixels -> the container's own coordinates (the units wires and parts are stored in). */
    getLocalCoords(clientX, clientY) {
        if (!this.simulationArea) return { x: 0, y: 0 };
        const area = this.areaRect();
        return {
            x: (clientX - area.left - this.view.x) / this.view.scale,
            y: (clientY - area.top - this.view.y) / this.view.scale
        };
    }

    /** The wire passing within 7 screen pixels of a point, if any (thin wires are hard to hit exactly). */
    wireNear(clientX, clientY) {
        const p = this.getLocalCoords(clientX, clientY);
        const reach = 7 / this.view.scale;
        let best = null, bestDist = reach;
        for (const w of this.wires) {
            const pts = w.points || [];
            for (let i = 1; i < pts.length; i++) {
                const a = pts[i - 1], b = pts[i];
                const dx = b.x - a.x, dy = b.y - a.y;
                const len2 = dx * dx + dy * dy;
                const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
                const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
                if (d < bestDist) { bestDist = d; best = w; }
            }
        }
        return best;
    }

    /** The board's rectangle in local units. */
    boardRect() {
        return { left: 0, top: 0, right: BOARD_WIDTH, bottom: this.boardHeight || this.container?.offsetHeight || 0 };
    }

    /**
     * Which way a pin points out of its board or part ('left' | 'right' | 'up' | 'down'): a wire leaves it that way.
     * Header pins 1-20 are on the board's left edge, 21-40 on its right. A part's pin points from the part's centre
     * towards the pin (after rotation and flip), along the longer axis: LED legs point down, resistor ends sideways.
     */
    pinDirection(port) {
        if (port.nodeType === 'gpio') return port.pin <= 20 ? 'left' : 'right';
        const comp = this.components.find((c) => c.id === port.componentId);
        const view = this.viewOf(comp);
        if (!comp || !view) return 'down';
        const [px, py] = transformPortOffset(view.portOffset(port.pin), view.size, comp.rotation, comp.flipped);
        const dx = px - view.size[0] / 2;
        const dy = py - view.size[1] / 2;
        return Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
    }

    /**
     * What the wire router needs (see wire-router.js): for every wire, both ends with the direction their pin points
     * and how far to go straight out before turning; and the rectangles no wire may cross (the board and every part).
     */
    routingInput() {
        const CLEAR = 18;                       // distance kept from a part or the board before a wire turns
        const LANE = 20;                        // extra stub length between neighbouring pins of the same part
        const inflate = (r, m) => ({ left: r.left - m, top: r.top - m, right: r.right + m, bottom: r.bottom + m });
        const board = this.boardRect();
        const partRects = new Map();
        for (const comp of this.components) {
            const view = this.viewOf(comp);
            if (view) partRects.set(comp.id, partBounds(comp.x, comp.y, view.size, comp.rotation));
        }
        const obstacles = [inflate(board, 4), ...[...partRects.values()].map((r) => inflate(r, 6))];

        // how far a pin is from the edge of its own board/part, going the way it points
        const stubFor = (port, p, dir) => {
            const own = port.nodeType === 'gpio' ? inflate(board, 4) : inflate(partRects.get(port.componentId) || { left: p.x, top: p.y, right: p.x, bottom: p.y }, 6);
            const edge = { left: p.x - own.left, right: own.right - p.x, up: p.y - own.top, down: own.bottom - p.y }[dir];
            return Math.max(0, edge) + CLEAR;
        };

        const requests = [];
        for (const w of this.wires) {
            const a = this.getPortCoords(w.start);
            const b = this.getPortCoords(w.end);
            if (!a || !b) continue;
            const end = (port, p) => { const dir = this.pinDirection(port); return { port, x: p.x, y: p.y, dir, stub: stubFor(port, p, dir) }; };
            requests.push({ id: w.id, start: end(w.start, a), end: end(w.end, b) });
        }

        // Pins of one part that point the same way get stubs of different lengths, the pin nearer the side the wires
        // come from getting the shorter one, so the wires leave in separate lanes instead of on top of each other.
        const groups = new Map();
        for (const r of requests) {
            for (const [mine, other] of [[r.start, r.end], [r.end, r.start]]) {
                if (mine.port.nodeType !== 'component_pin') continue;
                const key = `${mine.port.componentId}:${mine.dir}`;
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push({ mine, other });
            }
        }
        for (const list of groups.values()) {
            const pins = [...new Set(list.map((e) => `${e.mine.x},${e.mine.y}`))];
            if (pins.length < 2) continue;
            const vertical = list[0].mine.dir === 'up' || list[0].mine.dir === 'down';
            const across = (p) => (vertical ? p.x : p.y);
            const from = list.reduce((sum, e) => sum + across(e.other), 0) / list.length;    // where the wires come from
            const rank = pins.map((key) => { const [x, y] = key.split(',').map(Number); return { key, d: Math.abs(across({ x, y }) - from) }; })
                .sort((p, q) => p.d - q.d).map((p) => p.key);
            for (const e of list) e.mine.stub += rank.indexOf(`${e.mine.x},${e.mine.y}`) * LANE;
        }
        for (const r of requests) { delete r.start.port; delete r.end.port; }
        // the parts alone (not the board): a hand-routed wire may cross the board, but not run through a part
        const partObstacles = [...partRects.values()].map((r) => inflate(r, 2));
        return { requests, obstacles, partObstacles };
    }

    /** x of the gutter beside the board on the side of a pin (header pins 1-20 are on the left, 21-40 on the right). */
    boardGutterX(pin) {
        return pin <= 20 ? -GUTTER : BOARD_WIDTH + GUTTER;
    }

    /**
     * Show a pin's state with a class (colours in canvas.css): 'hot' (pointer over it), 'source' (a wire is being drawn
     * from it), 'valid' / 'invalid' (the wire being drawn may / may not end here), or null.
     */
    setPinState(elements, state) {
        for (const el of elements) {
            for (const name of ['hot', 'valid', 'invalid']) el.classList.toggle(`pin--${name}`, state === name);
        }
    }

    /** Mark (or unmark) the pin a wire is being drawn from. */
    markWireSource(port, on) {
        let elements = [];
        if (port.nodeType === 'gpio') elements = this.pinClusters[port.pin] || [];
        else {
            const comp = this.components.find((c) => c.id === port.componentId);
            const pin = comp && comp.div.querySelector(`[data-pin="${CSS.escape(String(port.pin))}"]`);
            if (pin) elements = [pin];
        }
        for (const el of elements) el.classList.toggle('pin--source', on);
    }

    /** A part's pin is under the pointer (called by the part views): highlight it, and say whether a wire may end there. */
    hoverPartPin(componentId, pinName, element, entering) {
        if (!entering) {
            this.setPinState([element], null);
            hideTip();
            return;
        }
        const target = this.wireManager.targetState({ nodeType: 'component_pin', componentId, pin: pinName });
        this.setPinState([element], target === 'valid' ? 'valid' : target === 'invalid' ? 'invalid' : 'hot');
        const meta = target === 'valid' ? 'Click to connect' : target === 'invalid' ? 'Cannot connect here' : '';
        showTip(element.getBoundingClientRect(), element.getAttribute('data-tooltip') || pinName, { mono: true, prefer: 'below', meta });
    }

    /** Centre of a board pin (by physical pin number) in local units, or null while the board is not laid out. */
    boardPinCoords(pin) {
        if (this._pinCoords[pin]) return this._pinCoords[pin];
        const element = this.pinElements[pin];
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return null;
        const center = this.getLocalCoords(rect.left + rect.width / 2, rect.top + rect.height / 2);
        this._pinCoords[pin] = center;
        return center;
    }

    /** The part view (drawing and edit behaviour) of a canvas component, or null for an unknown part. */
    viewOf(comp) {
        const descriptor = comp ? partTypeOf(comp) : null;
        return descriptor ? getPartView(descriptor.type) : null;
    }

    /** Where a pin is in local coordinates, including the part's rotation and flip. */
    getPortCoords(port) {
        if (port.nodeType === 'gpio') {
            // Wires drawn in the app remember where their board pin was; wires from example projects and share
            // scripts carry only the pin number, so the position comes from the board drawing.
            if (Number.isFinite(port.x) && Number.isFinite(port.y)) return { x: port.x, y: port.y };
            return this.boardPinCoords(port.pin);
        } else if (port.nodeType === 'component_pin') {
            const comp = this.components.find(c => c.id === port.componentId);
            if (comp) {
                // Pin position inside the part's unrotated drawing; each part view knows its own layout.
                const view = this.viewOf(comp);
                if (!view) return { x: comp.x, y: comp.y };
                const [px, py] = transformPortOffset(view.portOffset(port.pin), view.size, comp.rotation, comp.flipped);
                return { x: comp.x + px, y: comp.y + py };
            }
        }
        return null;
    }

    // --------------------------------------------------
    // Event Listeners (Global/Canvas)
    // --------------------------------------------------
    setupEventListeners() {
        if (!this.simulationArea || !this.container) return;
        const area = this.simulationArea;
        const inFloatingUi = (target) => target instanceof Element && !!target.closest('#component-popup, #canvas-hint, #perf-panel');

        area.addEventListener("wheel", (e) => {
            if (inFloatingUi(e.target)) return;
            e.preventDefault();
            const rect = this.areaRect();
            const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            this.setView(zoomAt(this.view, this.view.scale * wheelZoomFactor(wheelDeltaPx(e)), anchor), { user: true });
        }, { passive: false });

        area.addEventListener("mousedown", (e) => {
            if (e.button !== 0 && e.button !== 1) return;
            if (e.target.closest('.dynamic-led') || e.target.closest('.part') || inFloatingUi(e.target) || e.target.getAttribute('data-is-port')) return;

            if (this.wireManager.wireStartNode) {
                e.preventDefault();
                this.wireManager.addWaypoint(this.getLocalCoords(e.clientX, e.clientY));
                return;
            }

            // Wires are thin: a press within a few pixels of one selects it (instead of starting a pan)
            const near = this.wireNear(e.clientX, e.clientY);
            if (near) {
                e.preventDefault();
                this.wireManager.selectWire(near);
                return;
            }

            this.selectComponent(null);
            this.releaseFocus();
            e.preventDefault();                 // no text selection while dragging the background
            this.isPanning = true;
            const startX = e.clientX - this.view.x;
            const startY = e.clientY - this.view.y;
            area.classList.add("is-panning");

            // Listen on the window: the drag keeps working when the pointer crosses a panel or leaves the canvas.
            const move = (ev) => {
                this.setView({ scale: this.view.scale, x: ev.clientX - startX, y: ev.clientY - startY }, { user: true });
            };
            const up = () => {
                this.isPanning = false;
                area.classList.remove("is-panning");
                window.removeEventListener('mousemove', move);
                window.removeEventListener('mouseup', up);
            };
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up);
        });

        area.addEventListener("mousemove", (e) => {
            if (this.wireManager.wireStartNode) {
                this.wireManager.updateTempWire(e);
            }
        });

        area.addEventListener("contextmenu", (e) => {
            if (this.wireManager.wireStartNode) {
                e.preventDefault();
                this.wireManager.cancelWire();
            }
        });

        // The canvas changes size when a splitter moves, a panel opens, or the window (or browser zoom) changes.
        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(() => {
                if (this.pendingFit) this.settleInitialView();
                this.updatePopupPosition();
            }).observe(area);
        }
    }

    // --------------------------------------------------
    // View: pan and zoom
    // --------------------------------------------------

    /**
     * Apply a view. `user` means the viewer asked for it (wheel, drag, buttons): it is remembered for next time and
     * from then on the app never re-frames the circuit on its own.
     */
    setView(next, { user = false } = {}) {
        this.view = { scale: clampScale(next.scale), x: next.x, y: next.y };
        if (user) {
            this.userView = true;
            this.scheduleViewSave();
        }
        this.updateTransform();
    }

    updateTransform() {
        const { scale, x, y } = this.view;
        if (this.container) this.container.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;

        const area = this.simulationArea;
        if (area) {
            let step = 24 * scale;                     // dot grid: follows the circuit, thins out when zoomed far out
            while (step < 12) step *= 2;
            area.style.setProperty('--zoom', String(scale));
            area.style.setProperty('--inv-zoom', String(1 / scale));
            area.style.setProperty('--grid', `${step}px`);
            area.style.setProperty('--gx', `${((x % step) + step) % step}px`);
            area.style.setProperty('--gy', `${((y % step) + step) % step}px`);
        }
        // Parts' labels counter-scale through this variable too (it is inherited from the area).
        const label = document.getElementById("zoom-level-lbl");
        if (label) {
            const percent = Math.round(scale * 100);
            label.textContent = `${percent}%`;
            label.setAttribute('aria-label', `Zoom ${percent}%. Press to reset to 100%`);
        }
        this.updatePopupPosition();
        if (this.wireManager.selectedWireId) this.wireManager.renderHandles();   // handles keep their size on screen
    }

    scheduleViewSave() {
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => writePref('viewport', this.view), 250);
    }

    /** Use the viewport the viewer left last time, if there is one. */
    restoreSavedView() {
        const saved = readPref('viewport');
        const ok = saved && [saved.scale, saved.x, saved.y].every(Number.isFinite) && saved.scale >= 0.1 && saved.scale <= 5;
        if (ok) {
            this.view = { scale: saved.scale, x: saved.x, y: saved.y };
            this.userView = true;
        }
        this.updateTransform();
    }

    /** The rectangle that holds the board and every part, in local units. */
    contentBounds() {
        const rects = [{ left: 0, top: 0, right: BOARD_WIDTH, bottom: this.boardHeight || this.container?.offsetHeight || 0 }];
        for (const comp of this.components) {
            const view = this.viewOf(comp);
            if (view) rects.push(partBounds(comp.x, comp.y, view.size, comp.rotation));
        }
        return unionBounds(rects);
    }

    /**
     * Frame the board and all parts. Explicit (button, key) calls count as the viewer's choice; the automatic one
     * on first open does not.
     * @returns {boolean} false when the canvas has no size yet (hidden); the fit then happens as soon as it has one
     */
    fitToContent({ user = false } = {}) {
        const rect = this.areaRect();
        if (rect.width < 10 || rect.height < 10) { this.pendingFit = true; return false; }
        this.pendingFit = false;
        this.setView(fitView(this.contentBounds(), { width: rect.width, height: rect.height }, { padding: FIT_PADDING, maxScale: 1 }), { user });
        return true;
    }

    /**
     * Called once the board is loaded and the project restored. Keeps a viewport the viewer chose; frames the circuit
     * when there is none, or when the saved one would leave nothing at all on screen.
     */
    settleInitialView() {
        const rect = this.areaRect();
        if (rect.width < 10 || rect.height < 10) { this.pendingFit = true; return; }
        this.pendingFit = false;
        const nothingShown = !isVisible(this.view, this.contentBounds(), { width: rect.width, height: rect.height }, 8);
        if (!this.userView || nothingShown) this.fitToContent();
    }

    zoomBy(factor) {
        const rect = this.areaRect();
        this.setView(zoomAt(this.view, this.view.scale * factor, { x: rect.width / 2, y: rect.height / 2 }), { user: true });
    }

    zoomIn() { this.zoomBy(BUTTON_ZOOM_STEP); }

    zoomOut() { this.zoomBy(1 / BUTTON_ZOOM_STEP); }

    resetZoom() {
        const rect = this.areaRect();
        this.setView(zoomAt(this.view, 1, { x: rect.width / 2, y: rect.height / 2 }), { user: true });
    }

    /** Pan (never zoom) just enough that `bounds` (local units) is on screen. */
    revealBounds(bounds) {
        const rect = this.areaRect();
        const { scale } = this.view;
        const margin = 24;
        let { x, y } = this.view;
        const left = x + scale * bounds.left, right = x + scale * bounds.right;
        const top = y + scale * bounds.top, bottom = y + scale * bounds.bottom;
        if (left < margin) x += margin - left; else if (right > rect.width - margin) x -= right - (rect.width - margin);
        if (top < margin) y += margin - top; else if (bottom > rect.height - margin) y -= bottom - (rect.height - margin);
        if (x !== this.view.x || y !== this.view.y) this.setView({ scale, x, y });
    }

    // --------------------------------------------------
    // Component Management
    // --------------------------------------------------

    /**
     * Adds a new part of a registry type ('led', 'resistor', 'button') at its start position.
     * What the part is comes from the part registry, how it looks from its view.
     */
    addPart(type) {
        const descriptor = getPartType(type);
        const view = getPartView(type);
        if (!descriptor || !view) throw new Error('Unknown part type: ' + type);

        const index = partsOfType(this.components, type).length + 1;   // label number, e.g. "LED 2"
        const id = nextUniqueId(descriptor.idPrefix, (candidate) => this.components.some((c) => c.id === candidate));
        const { x, y } = this.freeSpotFor(view);
        const div = view.create(id, x, y, index, this);

        this.addComponent({ id, div, x, y, rotation: 0, ...descriptor.defaults() });
        this.revealBounds(partBounds(x, y, view.size, 0));          // the new part must not land off screen
    }

    /** A spot beside the board, in view, not covering the board's pins or another part (see geometry.spawnPosition). */
    freeSpotFor(view) {
        const rect = this.areaRect();
        if (rect.width < 10 || rect.height < 10) return view.startPosition;      // canvas not laid out: the old default
        const board = { left: 0, top: 0, right: BOARD_WIDTH, bottom: this.boardHeight || this.container.offsetHeight || 0 };
        const occupied = [board];
        for (const comp of this.components) {
            const v = this.viewOf(comp);
            if (v) occupied.push(partBounds(comp.x, comp.y, v.size, comp.rotation));
        }
        return spawnPosition(this.view, { width: rect.width, height: rect.height }, view.size, occupied, { board });
    }

    addLED() { this.addPart('led'); }

    addResistor() { this.addPart('resistor'); }

    /** Adds a new push button (4 pins, tracks its pressed state). */
    addPushButton() { this.addPart('button'); }

    addComponent(component) {
        if (this.container) {
            this.container.appendChild(component.div);
            this.components.push(component);
            this.selectComponent(component.id);
            if (this.onCircuitChange) this.onCircuitChange();
        }
    }

    startComponentDrag(e, div) {
        if (e.button !== 0) return;
        e.preventDefault();
        this.releaseFocus();
        let startMouseX = e.clientX;
        let startMouseY = e.clientY;

        const component = this.components.find(c => c.id === div.id);
        if (!component) return;

        let initialX = component.x;
        let initialY = component.y;

        const onMouseMove = (ev) => {
            if (this.wireManager.wireStartNode) return;

            ev.preventDefault();
            const dx = ev.clientX - startMouseX;
            const dy = ev.clientY - startMouseY;
            component.x = initialX + (dx / this.view.scale);
            component.y = initialY + (dy / this.view.scale);
            div.style.left = `${component.x}px`;
            div.style.top = `${component.y}px`;

            this.updatePopupPosition();
            this.wireManager.scheduleUpdateWires();       // re-routing all wires at most once per frame while dragging
            if (this.onCircuitChange) this.onCircuitChange();
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            this.wireManager.updateWires();
        };
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    /** Take keyboard focus out of whatever was being typed in, so Delete and R act on the canvas after a click on it. */
    releaseFocus() {
        const active = document.activeElement;
        if (active && active !== document.body && !active.closest('#component-popup')) active.blur();
    }

    /**
     * Select a part (or nothing, with null). Selecting anything else clears the wire selection too,
     * so a wire can never stay selected without its card showing.
     */
    selectComponent(id) {
        this.selectedComponentId = id;
        this.wireManager.selectedWireId = null;
        this.wireManager.renderHandles();            // a deselected wire shows no route handles

        this.components.forEach(c => c.div.classList.toggle('is-selected', c.id === id));

        // Reset Wires
        this.wires.forEach(w => {
            w.pathElement.setAttribute("stroke-width", "4");
            w.pathElement.classList.remove('is-selected');
        });

        if (id) {
            const comp = this.components.find(c => c.id === id);
            this.showComponentPopup(comp);
        } else {
            this.hidePopup();
        }
        this.refreshHint();
    }

    // --------------------------------------------------
    // Delegates for Interaction Managers
    // --------------------------------------------------
    handlePortClick(id, pin, type, rect, element) {
        // Proxy to WireManager
        // Need to construct portInfo expected by WireManager
        // { nodeType, componentId, pin, x, y }
        const rectCenter = this.getLocalCoords(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const portInfo = {
            nodeType: type,
            componentId: id,
            pin: pin,
            x: rectCenter.x,
            y: rectCenter.y
        };
        this.wireManager.handlePortClick(portInfo, element);
    }

    /** Tooltip for a pin of a part, anchored to the pin so it never jumps with the pointer. */
    showTooltip(text, anchorRect) {
        showTip(anchorRect, text, { mono: true, prefer: 'below' });
    }

    hideTooltip() {
        hideTip();
    }

    // --------------------------------------------------
    // Hint line
    // --------------------------------------------------

    /** Name a wire end for people: "GP15", "LED 1 anode", "Resistor 2 terminal 1". */
    describeNode(node) {
        if (node.nodeType === 'gpio') {
            const def = [...LEFT_PINS, ...RIGHT_PINS].find((p) => p.pin === node.pin);
            return def ? def.label : `pin ${node.pin}`;
        }
        const comp = this.components.find((c) => c.id === node.componentId);
        const view = this.viewOf(comp);
        if (!comp || !view) return 'a part pin';
        const n = indexAmongType(this.components, comp);
        const pinName = view.pinName ? view.pinName(node.pin) : `pin ${node.pin}`;
        return `${view.label} ${n} ${pinName}`;
    }

    /** What the hint line should say right now, from the current state. */
    currentHint() {
        if (this._hintFlash) return this._hintFlash;
        if (this.wireManager.wireStartNode) {
            const corners = (this.wireManager.waypoints || []).length;
            return { tone: 'active', text: `Wiring from ${this.describeNode(this.wireManager.wireStartNode)}. Click the canvas to add a corner, or another pin to finish.`, keys: corners ? [['Backspace', 'undo corner'], ['Esc', 'cancel']] : [['Esc', 'cancel']] };
        }
        if (this.selectedComponentId) {
            const comp = this.components.find((c) => c.id === this.selectedComponentId);
            const view = this.viewOf(comp);
            if (comp && view) {
                const keys = [['R', 'rotate'], ['Del', 'delete']];
                return { text: `${view.label} ${indexAmongType(this.components, comp)} selected. Drag to move.`, keys };
            }
        }
        if (this.wireManager.selectedWireId) return { text: 'Wire selected.', keys: [['Del', 'delete']] };
        if (this.components.length === 0 && this.wires.length === 0) {
            return { text: 'Add a part from the toolbar, then click one pin and another to wire them. Scroll to zoom, drag the background to pan.' };
        }
        if (this.wires.length === 0) return { text: 'Click a pin to start a wire, then click another pin to connect them.' };
        return null;
    }

    refreshHint() {
        renderHint(this.hintEl, this.currentHint());
    }

    /** Show a message for a few seconds in place of the usual hint (a refused connection, for example). */
    flashHint(text, tone = 'error', ms = 5000) {
        clearTimeout(this._hintTimer);
        this._hintFlash = { tone, text };
        this.refreshHint();
        this._hintTimer = setTimeout(() => { this._hintFlash = null; this.refreshHint(); }, ms);
    }

    // --------------------------------------------------
    // UI Popup Logic (Moved from main.js)
    // --------------------------------------------------
    showComponentPopup(comp) {
        this.componentPopup = document.getElementById("component-popup");
        if (!this.componentPopup) return;

        // Hide/Show correct controls
        const resistorControls = document.getElementById("resistor-controls");
        const ledControls = document.getElementById("led-controls");
        const popupFlip = document.getElementById("popup-flip");
        const popupRotate = document.getElementById("popup-rotate");
        const popupValue = document.getElementById("popup-value");
        const popupUnit = document.getElementById("popup-unit");
        const title = document.getElementById("popup-title");

        // Each part view says which popup controls apply (resistor value, LED colour, flip).
        const view = this.viewOf(comp);
        if (view) {
            const show = (element, visible) => { if (element) element.classList.toggle('hidden', !visible); };
            show(resistorControls, view.popup.resistorControls);
            show(ledControls, view.popup.ledControls);
            show(popupFlip, view.popup.flip);
            show(popupRotate, true);
            if (title) title.textContent = `${view.label} ${indexAmongType(this.components, comp)}`;
            this.setSwatchLabel('LED colour');
            this.markSwatches(comp.color);
            if (view.syncPopup) view.syncPopup(comp, { popupValue, popupUnit });
        }

        this.popupTarget = { kind: 'component', id: comp.id };
        this.componentPopup.classList.remove("hidden");
        this.updatePopupReadout();
        this.updatePopupPosition();
    }

    setSwatchLabel(text) {
        const label = document.getElementById('swatch-label');
        if (label) label.textContent = text;
    }

    /** Tick the colour swatch that matches `color` (none when it is not one of the palette colours). */
    markSwatches(color) {
        const wanted = (color || '').toLowerCase();
        document.querySelectorAll('#led-controls [data-color]').forEach((swatch) => {
            swatch.setAttribute('aria-checked', String(swatch.dataset.color === wanted));
        });
    }

    /** Called by the simulator after each solve; keeps the selected part's current/voltage up to date. */
    setElectricalState(result) {
        this.electrical = result;
        this.updatePopupReadout();
    }

    /** "3.00 mA · 1.91 V" under the popup title for the selected LED / resistor / button. */
    updatePopupReadout() {
        const readout = document.getElementById("popup-readout");
        if (!readout) return;
        const comp = this.selectedComponentId ? this.components.find(c => c.id === this.selectedComponentId) : null;
        const descriptor = comp ? partTypeOf(comp) : null;
        const text = descriptor && this.electrical ? readoutText(descriptor.type, this.electrical.parts[comp.id]) : '';
        readout.textContent = text;
        readout.classList.toggle("hidden", text === '');
        this.updatePopupPosition();                  // the card grows by a line when a readout appears
    }

    showWirePopup(wire) {
        this.componentPopup = document.getElementById("component-popup");
        if (!this.componentPopup) return;

        const resistorControls = document.getElementById("resistor-controls");
        const ledControls = document.getElementById("led-controls");
        const popupFlip = document.getElementById("popup-flip");
        const popupRotate = document.getElementById("popup-rotate");
        const title = document.getElementById("popup-title");

        const readout = document.getElementById("popup-readout");
        if (readout) readout.classList.add('hidden');
        if (resistorControls) resistorControls.classList.add('hidden');
        if (ledControls) ledControls.classList.remove('hidden'); // For color
        if (popupFlip) popupFlip.classList.add('hidden');
        if (popupRotate) popupRotate.classList.add('hidden');      // a wire has nothing to rotate
        if (title) title.textContent = 'Wire';
        this.setSwatchLabel('Wire colour');
        this.markSwatches(wire.color);

        this.popupTarget = { kind: 'wire', id: wire.id };
        this.componentPopup.classList.remove("hidden");
        this.updatePopupPosition();
        this.refreshHint();
    }

    hidePopup() {
        if (this.componentPopup) {
            this.componentPopup.classList.add("hidden");
        }
        this.popupTarget = null;
    }

    /** The rectangle (page pixels) of whatever the properties card belongs to. */
    popupAnchorRect() {
        const target = this.popupTarget;
        if (!target) return null;
        if (target.kind === 'component') {
            const comp = this.components.find(c => c.id === target.id);
            return comp ? comp.div.getBoundingClientRect() : null;
        }
        const wire = this.wires.find(w => w.id === target.id);
        return wire && wire.pathElement ? wire.pathElement.getBoundingClientRect() : null;
    }

    /** Place the card beside its part: above if it fits, below if not, always inside the canvas. */
    updatePopupPosition() {
        const popup = this.componentPopup;
        if (!popup || popup.classList.contains('hidden') || !this.popupTarget) return;
        const anchor = this.popupAnchorRect();
        if (!anchor) return;
        const area = this.areaRect();
        if (area.width === 0) return;

        const relative = { left: anchor.left - area.left, right: anchor.right - area.left, top: anchor.top - area.top, bottom: anchor.bottom - area.top };
        const pos = placeFloating(relative, { width: popup.offsetWidth, height: popup.offsetHeight },
            { left: 0, top: 0, right: area.width, bottom: area.height }, { gap: 14, gutter: 8 });
        popup.style.left = `${Math.round(pos.left)}px`;
        popup.style.top = `${Math.round(pos.top)}px`;
    }

    // Component Updates from UI
    updateSelectedComponentValue(val, unit) {
        if (!this.selectedComponentId) return;
        const comp = this.components.find(c => c.id === this.selectedComponentId);
        const view = this.viewOf(comp);
        if (view && view.setValue) {
            view.setValue(comp, val, unit);
            if (this.onCircuitChange) this.onCircuitChange();
        }
    }

    updateSelectedComponentColor(color) {
        if (this.selectedComponentId) {
            const comp = this.components.find(c => c.id === this.selectedComponentId);
            const view = this.viewOf(comp);
            if (view && view.setColor) view.setColor(comp, color);
        } else if (this.wireManager.selectedWireId) {
            const wire = this.wires.find(w => w.id === this.wireManager.selectedWireId);
            if (wire) {
                wire.color = color;
                wire.pathElement.setAttribute("stroke", color);
            }
        }
        this.markSwatches(color);
        if (this.onCircuitChange) this.onCircuitChange();
    }

    rotateSelectedComponent() {
        if (!this.selectedComponentId) return;
        const comp = this.components.find(c => c.id === this.selectedComponentId);
        if (comp) {
            comp.rotation = (comp.rotation + 90) % 360;
            this.applyTransform(comp);
            this.wireManager.updateWires();
            this.updatePopupPosition();
            if (this.onCircuitChange) this.onCircuitChange();
        }
    }

    flipSelectedComponent() {
        // Logic for flip
        if (this.selectedComponentId) {
            const comp = this.components.find(c => c.id === this.selectedComponentId);
            const view = this.viewOf(comp);
            if (view && view.canFlip) {
                comp.flipped = !comp.flipped;
                this.applyTransform(comp);
                this.wireManager.updateWires();
                this.updatePopupPosition();
                if (this.onCircuitChange) this.onCircuitChange();
            }
        }
    }

    deleteSelected() {
        if (this.selectedComponentId) {
            const compIdx = this.components.findIndex(c => c.id === this.selectedComponentId);
            if (compIdx > -1) {
                const comp = this.components[compIdx];
                comp.div.remove();
                this.components.splice(compIdx, 1);

                // Remove connected wires
                this.wires = this.wires.filter(w => {
                    if (w.start.componentId === comp.id || w.end.componentId === comp.id) {
                        w.pathElement.remove();
                        return false;
                    }
                    return true;
                });

                syncWires(this.wires);          // the connection graph must see the wires that went with the component
                this.wireManager.updateWires();  // the lanes those wires used are free again

                this.selectComponent(null);
                if (this.onCircuitChange) this.onCircuitChange();
            }
        } else if (this.wireManager.selectedWireId) {
            this.wireManager.deleteWire(this.wireManager.selectedWireId);
        }
    }

    applyTransform(comp) {
        const scaleX = comp.flipped ? -1 : 1;
        comp.div.style.transform = `rotate(${comp.rotation}deg) scaleX(${scaleX})`;
        // The part's label undoes this turn and flip so its text stays upright and readable (see .part-label in canvas.css)
        comp.div.style.setProperty('--rot', `${comp.rotation}deg`);
        comp.div.style.setProperty('--flip', String(scaleX));
    }

    // --------------------------------------------------
    // Project Restore (Save & Share)
    // --------------------------------------------------

    /**
     * Removes all components and wires from the canvas.
     * Used before restoring a saved project.
     */
    clearAll() {
        // Remove all wires
        this.wires.forEach(w => {
            if (w.pathElement) w.pathElement.remove();
        });
        this.wires = [];
        syncWires(this.wires);

        // Remove all components
        this.components.forEach(c => {
            if (c.div) c.div.remove();
        });
        this.components = [];

        this.wireManager.selectedWireId = null;
        this.selectedComponentId = null;
        this.hidePopup();
        this.wireManager.renderHandles();
        this.refreshHint();
    }

    /**
     * Recreates a component from serialized project data.
     *
     * @param {object} data — serialized component { id, type, x, y, rotation, color, value, unit, flipped }
     */
    restoreComponent(data) {
        const descriptor = getPartType(data.type);
        const view = getPartView(data.type);
        if (!descriptor || !view) {
            console.warn('[CanvasManager] Unknown component type:', data.type);
            return;
        }

        const index = partsOfType(this.components, data.type).length + 1;
        const div = view.create(data.id, data.x, data.y, index, this);
        const component = {
            id: data.id,
            x: data.x,
            y: data.y,
            rotation: data.rotation || 0,
            div,
            ...descriptor.restore(data)
        };

        if (this.container) {
            this.container.appendChild(div);
            this.components.push(component);

            // Apply saved transforms
            if (data.rotation || data.flipped) {
                this.applyTransform(component);
            }

            // Update the drawing for saved values (resistor bands, LED colour)
            if (view.afterRestore) view.afterRestore(component, data);
        }
    }

    /**
     * Recreates a wire from serialized project data.
     *
     * @param {object} wireData — { start: {nodeType, pin, ...}, end: {nodeType, pin, ...}, color }
     */
    restoreWire(wireData) {
        const wire = this.wireManager.createWire(wireData.start, wireData.end, wireData.id);
        if (wire && Array.isArray(wireData.route) && wireData.route.length) {
            // a shape the user drew by hand: re-attached to the pins on the next routing pass
            wire.savedRoute = wireData.route.map(([x, y]) => ({ x, y }));
            this.wireManager.updateWires();
        }
        if (wire && wireData.color) {
            wire.color = wireData.color;
            wire.pathElement.setAttribute('stroke', wireData.color);
        }
        this.refreshHint();
    }
}

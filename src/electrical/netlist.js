/**
 * netlist.js — turns the canvas (components + wires) and the pad states into a solver circuit (pure)
 *
 * Input:
 *   components  [{ id, color?, value?, unit?, isPressed? ... }]   (ids tell the registry which part they are)
 *   wires       [{ start, end }]  with endpoints { nodeType:'gpio', pin:<physical pin> }
 *                                 or             { nodeType:'component_pin', componentId, pin }
 *   pads        { [gpioNumber]: partial pad state }               see normalizePad()
 *   params      resolved board parameters (board-params.js)
 *
 * Rules:
 *   - A wire is ideal: it merges the two pins into ONE node.
 *   - All GND pins are node 0. 3V3(OUT)/VBUS/VSYS are sources behind a resistance.
 *     3V3_EN, ADC_VREF and RUN are ordinary unconnected nodes (B7).
 *   - LED = LED element (anode 'A', cathode 'C'); resistor = real resistance; button = the two contact
 *     rows are each joined, and a switch bridges them (closed while pressed).
 *   - Every GPIO pad is present: output = source (3.3 V behind padHighOhms, or 0 V behind padLowOhms),
 *     input = its pull (pullOhms to 3.3 V or to GND), or nothing.
 *
 * Element ids: part ids as given; `rail:<label>`, `pad:GP<n>` (output stage), `pull:GP<n>` (pull resistor).
 */

import { partTypeOfId } from '../circuit/part-types.js';
import { ledModelForColor } from './led-model.js';
import { classifyPhysicalPin, physicalPinOfGpio, headerGpios } from './pico-pins.js';
import { DRIVE_STRENGTHS_AMPS } from './board-params.js';

/** Defaults are the chip's reset state: input, pull-down enabled (B9). */
export function normalizePad(partial = {}, params) {
  const pad = {
    mode: partial.mode === 'output' ? 'output' : 'input',
    level: partial.level === 1 || partial.level === true ? 1 : 0,
    pull: partial.pull === 'up' || partial.pull === 'none' ? partial.pull : 'down',
    driveAmps: params.padDriveAmps,
    duty: null,
    previousRead: partial.previousRead === 1 ? 1 : 0
  };
  if (partial.driveAmps !== undefined) {
    if (!DRIVE_STRENGTHS_AMPS.includes(partial.driveAmps)) throw new RangeError(`drive strength ${partial.driveAmps} A is not one of 2/4/8/12 mA`);
    pad.driveAmps = partial.driveAmps;
  }
  if (partial.duty !== undefined && partial.duty !== null) {
    if (typeof partial.duty !== 'number' || !(partial.duty >= 0 && partial.duty <= 1)) throw new RangeError('duty must be between 0 and 1');
    pad.duty = partial.duty;
  }
  return pad;
}

class DisjointSets {
  constructor() { this.parent = new Map(); }
  find(key) {
    if (!this.parent.has(key)) this.parent.set(key, key);
    let root = key;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    while (this.parent.get(key) !== root) { const next = this.parent.get(key); this.parent.set(key, root); key = next; }
    return root;
  }
  union(a, b) { const ra = this.find(a); const rb = this.find(b); if (ra !== rb) this.parent.set(ra, rb); }
}

const GROUND = 'ground';
const TYPE_NAMES = { led: 'LED', resistor: 'Resistor', button: 'Button' };
/** "LED 1700000000000" from the registry type and the id's unique suffix (no id-prefix spelling here). */
function partLabel(descriptor, comp) {
  return `${TYPE_NAMES[descriptor.type] || descriptor.type} ${comp.id.slice(comp.id.indexOf('_') + 1)}`;
}
const pinKey = (physical) => `pin:${physical}`;
const compKey = (id, pin) => `comp:${id}:${pin}`;
const endpointKey = (n) => (n.nodeType === 'gpio' ? pinKey(n.pin) : compKey(n.componentId, n.pin));

/**
 * @param {object} spec  { components, wires, pads, params, padLevels? }
 *   padLevels: optional {gpio: 0|1} overriding the output level of PWM pads for one sub-solve.
 * @returns {{ circuit, meta }}
 *   meta.nodeOfGpio[g]   solver node of pad g;      meta.wiredGpios  Set of pads with a wire attached
 *   meta.drivenNodes     nodes that reach ground, a rail or an output pad through wires/parts (see below)
 *   meta.heldNodes       as drivenNodes but pull resistors count too; a node outside it is truly floating
 *   meta.padInfo[g]      normalized pad state;      meta.netMembers  Map node -> {highs:[], lows:[], pads:[]} (for contention)
 *   meta.notes           non-fatal oddities (ignored parts, bad values)
 */
export function buildNetlist({ components = [], wires = [], pads = {}, params, padLevels = {} }) {
  const sets = new DisjointSets();
  const notes = [];
  const wiredEndpoints = new Set();

  // 1. Ground and button rows are merged ideally; every wire merges its two endpoints.
  const groundPins = [];
  for (let physical = 1; physical <= 40; physical++) {
    const c = classifyPhysicalPin(physical);
    if (c && c.kind === 'ground') groundPins.push(pinKey(physical));
  }
  for (const k of groundPins) sets.union(k, GROUND);

  const parts = [];
  for (const comp of components) {
    const descriptor = partTypeOfId(comp && comp.id);
    if (!descriptor) { notes.push(`ignored component with unknown id "${comp && comp.id}"`); continue; }
    parts.push({ comp, descriptor });
    if (descriptor.role === 'switch') {
      sets.union(compKey(comp.id, '1'), compKey(comp.id, '2'));
      sets.union(compKey(comp.id, '3'), compKey(comp.id, '4'));
    }
  }
  for (const w of wires) {
    if (!w || !w.start || !w.end) continue;
    const a = endpointKey(w.start); const b = endpointKey(w.end);
    sets.union(a, b);
    wiredEndpoints.add(a); wiredEndpoints.add(b);
  }

  // 2. Number the nets: ground is 0.
  const nodeIds = new Map([[sets.find(GROUND), 0]]);
  let nodeCount = 0;
  const nodeOf = (key) => {
    const root = sets.find(key);
    if (!nodeIds.has(root)) nodeIds.set(root, ++nodeCount);
    return nodeIds.get(root);
  };

  const elements = [];
  const nodeOfGpio = {};
  const wiredGpios = new Set();
  const padInfo = {};
  const netMembers = new Map();
  const member = (node) => {
    if (!netMembers.has(node)) netMembers.set(node, { highs: [], lows: [], pads: [] });
    return netMembers.get(node);
  };

  // 3. Parts
  for (const { comp, descriptor } of parts) {
    if (descriptor.role === 'diode') {
      elements.push({ type: 'led', id: comp.id, anode: nodeOf(compKey(comp.id, 'A')), cathode: nodeOf(compKey(comp.id, 'C')),
        model: ledModelForColor(comp.color), label: partLabel(descriptor, comp) });
    } else if (descriptor.role === 'resistor') {
      let ohms = (Number(comp.value) || 0) * (Number(comp.unit) || 1);
      if (!Number.isFinite(ohms) || ohms < 0) { notes.push(`resistor ${comp.id} has an invalid value; treated as 0 ohm`); ohms = 0; }
      elements.push({ type: 'resistor', id: comp.id, a: nodeOf(compKey(comp.id, '1')), b: nodeOf(compKey(comp.id, '2')), ohms,
        label: partLabel(descriptor, comp) });
    } else if (descriptor.role === 'switch') {
      elements.push({ type: 'switch', id: comp.id, a: nodeOf(compKey(comp.id, '1')), b: nodeOf(compKey(comp.id, '3')),
        closed: !!comp.isPressed, ohms: params.buttonOhms, label: partLabel(descriptor, comp) });
    }
  }

  // 4. Rails
  const railSpec = {
    '3V3(OUT)': [params.rail3v3Volts, params.rail3v3Ohms, params.rail3v3MaxAmps],
    VBUS: [params.vbusVolts, params.vbusOhms, params.vbusMaxAmps],
    VSYS: [params.vsysVolts, params.vsysOhms, params.vsysMaxAmps]
  };
  for (let physical = 1; physical <= 40; physical++) {
    const c = classifyPhysicalPin(physical);
    if (!c || c.kind !== 'rail') continue;
    const [volts, ohms, ratedAmps] = railSpec[c.label];
    const node = nodeOf(pinKey(physical));
    elements.push({ type: 'source', id: `rail:${c.label}`, node, volts, ohms, ratedAmps, label: c.label });
    member(node).highs.push(c.label);
  }
  // ground members (for contention): only if some pad shares the net, checked later
  member(0).lows.push('GND');

  // 5. Pads
  const sourceMembers = []; const sinkMembers = [];
  for (const gpio of headerGpios()) {
    const physical = physicalPinOfGpio(gpio);
    const key = pinKey(physical);
    const node = nodeOf(key);
    nodeOfGpio[gpio] = node;
    if (wiredEndpoints.has(key)) wiredGpios.add(gpio);
    const pad = normalizePad(pads[gpio], params);
    padInfo[gpio] = pad;
    const label = `GP${gpio}`;
    member(node).pads.push(gpio);
    if (pad.mode === 'output') {
      const level = padLevels[gpio] !== undefined ? padLevels[gpio] : (pad.duty !== null ? (pad.duty >= 0.5 ? 1 : 0) : pad.level);
      const high = level === 1;
      const id = `pad:${label}`;
      elements.push({ type: 'source', id, node, volts: high ? params.rail3v3Volts : 0, ohms: high ? params.padHighOhms : params.padLowOhms,
        ratedAmps: pad.driveAmps, absoluteMaxAmps: params.padAbsoluteMaxAmps, label });
      (high ? member(node).highs : member(node).lows).push(label);
      sourceMembers.push(id); sinkMembers.push(id);
    } else if (pad.pull !== 'none') {
      elements.push({ type: 'source', id: `pull:${label}`, node, volts: pad.pull === 'up' ? params.rail3v3Volts : 0, ohms: params.pullOhms, label: `${label} pull-${pad.pull}` });
    }
  }

  const groups = [
    { id: 'gpio-source-total', label: 'all GPIO pins', members: sourceMembers, maxAmps: params.gpioTotalAmps, direction: 'source' },
    { id: 'gpio-sink-total', label: 'all GPIO pins', members: sinkMembers, maxAmps: params.gpioTotalAmps, direction: 'sink' }
  ];

  // 6. Which nodes are "driven"? A node is driven if it can reach a hard source (ground, a rail, an output
  //    pad) through resistors, closed switches or LEDs. Pull resistors are NOT hard sources: an input whose net
  //    is only held by its own pull is "floating" (the firmware's pull setting decides what it reads).
  const adjacent = new Map();
  const link = (a, b) => {
    if (!adjacent.has(a)) adjacent.set(a, []);
    if (!adjacent.has(b)) adjacent.set(b, []);
    adjacent.get(a).push(b); adjacent.get(b).push(a);
  };
  for (const e of elements) {
    if (e.type === 'resistor') link(e.a, e.b);
    else if (e.type === 'switch' && e.closed) link(e.a, e.b);
    else if (e.type === 'led') link(e.anode, e.cathode);
  }
  const drivenNodes = new Set([0]);
  const frontier = [0];
  for (const e of elements) {
    if (e.type === 'source' && (e.id.startsWith('rail:') || e.id.startsWith('pad:')) && !drivenNodes.has(e.node)) { drivenNodes.add(e.node); frontier.push(e.node); }
  }
  while (frontier.length) {
    const n = frontier.pop();
    for (const m of adjacent.get(n) || []) if (!drivenNodes.has(m)) { drivenNodes.add(m); frontier.push(m); }
  }

  // "Held" nodes also count pull resistors: a node nothing holds at all (no rail, ground, pad or pull reaches it)
  // is genuinely floating, and an input there keeps whatever it read last.
  const heldNodes = new Set([0]);
  const heldFrontier = [0];
  for (const e of elements) {
    if (e.type === 'source' && !heldNodes.has(e.node)) { heldNodes.add(e.node); heldFrontier.push(e.node); }
  }
  while (heldFrontier.length) {
    const n = heldFrontier.pop();
    for (const m of adjacent.get(n) || []) if (!heldNodes.has(m)) { heldNodes.add(m); heldFrontier.push(m); }
  }

  return { circuit: { nodeCount, elements, groups }, meta: { nodeOfGpio, wiredGpios, padInfo, netMembers, drivenNodes, heldNodes, notes } };
}

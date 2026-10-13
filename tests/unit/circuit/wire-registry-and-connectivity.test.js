import { describe, it, expect, beforeEach } from 'vitest';
import { syncWires, addWire, removeWire, getWires, isDuplicate, nodesEqual, validateWire } from '../../../src/circuit/wire-registry.js';
import {
  getButtonConnectedPins, analyzeNet, analyzeGpioNet, netDrive,
  checkConnection, isGpioConnectedTo, findDrivingGpio,
} from '../../support/legacy-connectivity.js';

// Physical pins on the Pico header: GP0 = 1, GP15 = 20, GND.1 = 3, 3V3(OUT) = 36, VBUS = 40
const gpio = (pin) => ({ nodeType: 'gpio', pin });
const cp = (componentId, pin) => ({ nodeType: 'component_pin', componentId, pin });
let nextId = 0;
const wire = (a, b) => ({ id: `wire_${++nextId}`, start: a, end: b });
const button = (id, pressed = false) => ({ id, isPressed: pressed });
const alwaysLow = () => false;

beforeEach(() => syncWires([]));

describe('button internal connections', () => {
  it('top row and bottom row are each always joined; pressing joins them together', () => {
    expect(getButtonConnectedPins('1', false).sort()).toEqual(['2']);
    expect(getButtonConnectedPins('3', false).sort()).toEqual(['4']);
    expect(getButtonConnectedPins('1', true).sort()).toEqual(['2', '3', '4']);
    expect(getButtonConnectedPins('4', true).sort()).toEqual(['1', '2', '3']);
  });
});

describe('analyzeGpioNet / netDrive', () => {
  it('a GPIO wired through a released button to GND is floating, pressed it is driven low', () => {
    const released = [button('btn_1', false)];
    syncWires([wire(gpio(1), cp('btn_1', '1')), wire(gpio(3), cp('btn_1', '3'))]);
    expect(netDrive(analyzeGpioNet(0, released))).toBeNull();
    expect(netDrive(analyzeGpioNet(0, [button('btn_1', true)]))).toBe(0);
  });

  it('a GPIO wired through a pressed button to 3V3 is driven high; released it floats', () => {
    syncWires([wire(gpio(1), cp('btn_1', '1')), wire(gpio(36), cp('btn_1', '3'))]);
    expect(netDrive(analyzeGpioNet(0, [button('btn_1', true)]))).toBe(1);
    expect(netDrive(analyzeGpioNet(0, [button('btn_1', false)]))).toBeNull();
  });

  it('passes through a resistor (it is a plain conductor in this model)', () => {
    syncWires([wire(gpio(1), cp('res_1', '1')), wire(gpio(3), cp('res_1', '2'))]);
    expect(netDrive(analyzeGpioNet(0, [{ id: 'res_1' }]))).toBe(0);
  });

  it('an unwired GPIO floats; a short between ground and power reads as ground', () => {
    expect(netDrive(analyzeGpioNet(0, []))).toBeNull();
    syncWires([wire(gpio(1), gpio(3)), wire(gpio(1), gpio(36))]);
    const net = analyzeGpioNet(0, []);
    expect(net.isGrounded && net.hasPower).toBe(true);
    expect(netDrive(net)).toBe(0);
  });

  it('reports other GPIOs on the same net and ignores unknown GPIO numbers', () => {
    syncWires([wire(gpio(1), gpio(2))]); // GP0 <-> GP1
    expect(analyzeGpioNet(0, []).gpios.sort()).toEqual([0, 1]);
    expect(analyzeGpioNet(99, [])).toEqual({ gpios: [], isGrounded: false, hasPower: false });
  });
});

describe('analyzeNet (from a component pin)', () => {
  it('reports ground and power reachability', () => {
    syncWires([wire(cp('btn_1', '1'), gpio(36)), wire(cp('btn_1', '3'), gpio(3))]);
    const pressed = [button('btn_1', true)];
    const net = analyzeNet('btn_1', '1', pressed);
    expect(net.isGrounded).toBe(true);
    expect(net.hasPower).toBe(true);
  });
});

describe('LED connectivity', () => {
  const led = { id: 'led_1' };

  it('anode counts as powered only when its GPIO drives high (and firmware is running)', () => {
    syncWires([wire(gpio(20), cp('led_1', 'A')), wire(gpio(3), cp('led_1', 'C'))]); // GP15 -> LED -> GND
    const gp15High = (gp) => gp === 15;
    expect(checkConnection('led_1', 'A', 'Power', [led], gp15High, true)).toBe(true);
    expect(checkConnection('led_1', 'A', 'Power', [led], alwaysLow, true)).toBe(false);
    expect(checkConnection('led_1', 'A', 'Power', [led], gp15High, false)).toBe(false); // no worker
    expect(checkConnection('led_1', 'C', 'Ground', [led], alwaysLow, true)).toBe(true);
    expect(findDrivingGpio('led_1', [led])).toBe(15);
    expect(isGpioConnectedTo(15, 'led', [led])).toBe(true);
    expect(isGpioConnectedTo(14, 'led', [led])).toBe(false);
  });
});

describe('wire registry', () => {
  it('rejects duplicate wires in either direction and fires the removal callback target', () => {
    syncWires([]);
    const a = wire(gpio(1), cp('led_1', 'A'));
    expect(addWire(a)).toBe(true);
    expect(addWire(wire(cp('led_1', 'A'), gpio(1)))).toBe(false);
    expect(isDuplicate(gpio(1), cp('led_1', 'A'))).toBe(true);
    expect(validateWire(gpio(1), gpio(1)).valid).toBe(false);
    expect(removeWire(a.id)).toBe(a);
    expect(getWires()).toHaveLength(0);
    expect(nodesEqual(cp('a_1', '1'), cp('a_1', '1'))).toBe(true);
  });
});

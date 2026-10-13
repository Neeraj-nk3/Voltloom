/**
 * SimulatorBridge — runs a program (Python or C) against the simulated Pico and the canvas circuit.
 *
 * Lifecycle (one program at a time):
 *   run(code) / runC(code)  start a program; any previous program is torn down first
 *   stop()                  terminate the program and reset the simulated hardware
 *   restart(kind)           the program asked to reset: restart the same program on fresh hardware
 *
 * Both languages run in their own Web Worker (src/runtime/python/worker.js for MicroPython, worker.js for
 * compiled C). Stopping a program is Worker.terminate(), so nothing a program does can keep running
 * after Stop. The workers talk to this class with the typed messages in src/worker-protocol/protocol.js.
 *
 * Hardware state lives in the sim/ engines (gpio, pwm, wifi, ...). This class applies worker events
 * to them, solves the circuit (src/electrical) and updates the LEDs, inputs and warnings.
 */

import { initSerial, print, printError, printWarning, printSystem } from '../ui/panels/serial-output.js';
import { setLedBrightness } from '../ui/parts/led-view.js';
import { setPushButtonPressed } from '../ui/parts/push-button-view.js';
import {
    handlePinAction,
    updateInputState,
    isOutputHigh,
    resetGpio,
    initSharedMemory,
    initializePin,
    configurePull,
    queryPinState,
    GPIO_OUT,
    PULL_UP,
    PULL_DOWN
} from '../hardware/gpio-bridge.js';
import { isPinPwm, getPwmDutyCycle, resetPwm, pwmSetWrap, pwmSetChanLevel, pwmSetEnabled, pwmSetClkdiv } from '../hardware/pwm-bridge.js';
import { resetWifi, wifiInit, wifiDeinit, wifiEnableStaMode, wifiConnect } from '../hardware/wifi-bridge.js';
import { resetFs, fsInit, fsWrite, fsRead, fsExists, fsDelete } from '../hardware/fs-bridge.js';
import { performReset } from '../hardware/reset-bridge.js';
import { wasWatchdogReset, getResetState, clearResetCause } from '../hardware/reset-sim.js';
import { compileCode, isCCode } from './compile-client.js';
import {
    resolvePinDef,
    extractGpioNumber,
    syncWires,
    setOnWireRemoved
} from '../circuit/wire-registry.js';
import { createCircuitEngine, warningKey } from '../electrical/circuit-engine.js';
import { ledBrightness } from '../electrical/led-model.js';
import { headerGpios } from '../electrical/pico-pins.js';
import { createCircuitBuffer, writeCircuit, snapshotCircuit } from '../electrical/circuit-channel.js';
import { initDebugState, handleWorkerPaused } from '../debug/debug-bridge.js';
import { resetDebugger, getBreakpoints, onDebuggerHit } from '../debug/debugger.js';
import { reportPropagationTime, reportWorkerLatency } from '../ui/panels/performance-monitor.js';
import { validateCircuit } from '../circuit/circuit-validator.js';
import { partsOfType } from '../circuit/part-types.js';
import { COMMAND, EVENT, NUM_GPIO, SHARED_OUTPUT_BASE, SHARED_PINS_LENGTH } from '../worker-protocol/protocol.js';
import { createMailbox, respond } from '../worker-protocol/rpc-mailbox.js';

export { isCCode };

// Pico pin types that can act as GPIO inputs (the ADC pins are GPIOs too).
const GPIO_PIN_TYPES = ['GPIO', 'ADC0', 'ADC1', 'ADC2'];

// A program that resets itself in a tight loop must not turn into a worker-creation storm.
const MIN_RESTART_INTERVAL_MS = 300;
const RESET_LOOP_WINDOW_MS = 5000;
const RESET_LOOP_LIMIT = 10;

const OUTPUT_RECONCILE_MS = 50;
const PING_INTERVAL_MS = 500;

export class SimulatorBridge {
    constructor(canvasManager, outputElement) {
        this.canvasManager = canvasManager;
        initSerial(outputElement); // Initialize serial output layer

        // The running program: { id, language, program, worker, startedAt }, or null.
        this.session = null;
        this.worker = null;            // === this.session?.worker; a non-null worker means "firmware running"
        this.state = 'stopped';        // 'running' | 'stopped' (see onStateChange)
        this.onStateChange = null;     // optional callback(state) so the UI can follow the lifecycle
        this.onPhaseChange = null;     // optional callback('compiling' | 'running'): what a running state is doing (UI wording only)

        this.sessionCounter = 0;
        // 'realtime' (default): programs run at real speed. 'fast': sleeps return at once on the virtual timeline
        // (tests). Applies to the next Run. See src/clock/virtual-clock.js.
        this.clockMode = 'realtime';
        this.runToken = 0;             // bumped by every run/stop/restart; late async results compare against it
        this.compileAbort = null;      // AbortController of an in-flight compile request
        this.restarting = false;
        this.resetTimes = [];

        // SharedArrayBuffer shared with the worker: circuit-driven input levels and program output levels.
        this.sharedBuffer = null;
        this.sharedPins = null;        // Int32Array view

        // Track pins that have already shown connection errors (avoid spam)
        this.erroredOutputPins = new Set();
        this.erroredInputPins = new Set();

        // GPIOs whose circuit drive was last published to the firmware (see _publishInputs)
        this.drivenInputs = new Set();

        // The electrical engine: solves the whole circuit (src/electrical). It is stateful only for
        // input-threshold memory, a cache and warning bookkeeping; see circuit-engine.js.
        this.engine = createCircuitEngine();
        this.headerGpios = headerGpios();
        // Warnings already printed to the console since the last run/stop/circuit edit. A condition that comes
        // and goes (a blinking LED that is over-driven) is printed once, but the badge follows it live.
        this.printedWarnings = new Set();
        this.pinFunctions = {};        // gpio -> function select reported by the firmware (4 = PWM); reset with each run

        this.circuitDirty = false;     // set while applying a batch of worker events
        this.pingInterval = null;
        this.reconcileInterval = null;

        // When a wire is removed, re-evaluate the circuit
        setOnWireRemoved(() => {
            this.updateCircuit();
        });
    }

    /**
     * Connects the button press callback to the canvas manager.
     * Called after both CanvasManager and SimulatorBridge are created.
     */
    setupButtonCallback() {
        this.canvasManager.onButtonPress = (componentId, isPressed) => {
            this.handleButtonPress(componentId, isPressed);
        };
    }

    // ───────────────────────── lifecycle ─────────────────────────

    _setState(state) {
        if (this.state === state) return;
        this.state = state;
        if (this.onStateChange) this.onStateChange(state);
    }

    /** Cancel whatever is pending (compile, restart), end the current program, and mark the run as started. */
    _beginRun() {
        this.runToken++;
        if (this.compileAbort) { this.compileAbort.abort(); this.compileAbort = null; }
        this.restarting = false;
        this._teardownWorker();
        clearResetCause();             // a program the user starts begins from power-on
        this._setState('running');
        return this.runToken;
    }

    /** Terminate the worker (and with it the program) and the timers that watch it. */
    _teardownWorker() {
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
        if (this.reconcileInterval) { clearInterval(this.reconcileInterval); this.reconcileInterval = null; }
        if (this.worker) {
            try { this.worker.terminate(); } catch (e) { console.warn('[SimulatorBridge] terminate failed:', e); }
        }
        this.worker = null;
        this.session = null;
        this.sharedBuffer = null;
        this.sharedPins = null;
    }

    /** Forget electrical memory and re-solve the circuit from the (freshly reset) hardware state. */
    _resetCircuit() {
        this.pinFunctions = {};
        this.engine.reset();
        this.printedWarnings.clear();
        this.updateCircuit();
    }

    /** The user edited the circuit (parts or wires): warnings may be reported afresh. */
    circuitEdited() {
        this.printedWarnings.clear();
        this.updateCircuit();
    }

    /** Start a Python program. */
    run(code) {
        this._beginRun();
        if (this.onPhaseChange) this.onPhaseChange('running');
        printSystem("Initializing Worker...");
        this._launch({ language: 'python', code });
    }

    /**
     * Compile C code with the local compile service and run it.
     * Stop (or another Run) while compiling cancels this run.
     *
     * @param {string} code — user C source
     * @returns {Promise<boolean>} true if the program was started
     */
    async runC(code) {
        const token = this._beginRun();
        if (this.onPhaseChange) this.onPhaseChange('compiling');
        printSystem('Compiling C code...');

        const controller = new AbortController();
        this.compileAbort = controller;
        let result;
        try {
            result = await compileCode(code, { signal: controller.signal });
        } catch (err) {
            if (token !== this.runToken) return false;          // cancelled: Stop already reported
            printError(`Compiler error: ${err.message}`);
            console.error('[SimulatorBridge] runC error:', err);
            this._setState('stopped');
            return false;
        } finally {
            if (this.compileAbort === controller) this.compileAbort = null;
        }
        if (token !== this.runToken) return false;              // stopped or superseded while compiling

        if (result.error) {
            printError('Compilation failed:');
            result.error.split('\n').forEach(line => {
                if (line.trim()) printError(line);
            });
            this._setState('stopped');
            return false;
        }

        printSystem('Loading WASM firmware...');
        if (!this._launch({ language: 'c', code, moduleJs: result.js })) return false;
        if (this.onPhaseChange) this.onPhaseChange('running');
        printSystem(`Firmware running (JS: ${result.size.js} bytes)`);
        return true;
    }

    /**
     * Start a program in a fresh worker on freshly reset hardware.
     * @param {{language: 'python'|'c', code: string, moduleJs?: string}} program
     * @returns {boolean} false if it could not be started
     */
    _launch(program) {
        const canShare = typeof SharedArrayBuffer !== 'undefined';
        if (program.language === 'c' && !canShare) {
            printError('C programs need a cross-origin-isolated page (SharedArrayBuffer is not available). See docs/deployment.md.');
            this._setState('stopped');
            return false;
        }

        this._teardownWorker();

        // Hardware and circuit state for a clean start
        document.querySelectorAll(".dynamic-led").forEach(el => el.remove());
        resetGpio();
        resetPwm();
        this.erroredOutputPins.clear();
        this.erroredInputPins.clear();
        this.drivenInputs.clear();
        syncWires(this.canvasManager.wires);
        this._resetCircuit();
        resetDebugger();

        const worker = program.language === 'c'
            ? new Worker(new URL('../runtime/c/worker.js', import.meta.url), { type: 'module' })
            : new Worker(new URL('../runtime/python/worker.js', import.meta.url), { type: 'module' });
        const session = { id: ++this.sessionCounter, language: program.language, program, worker, startedAt: performance.now(), rpcBuffer: null, circuitBuffer: null };
        this.session = session;
        this.worker = worker;

        worker.onmessage = (e) => this._onWorkerMessage(session, e.data);
        worker.onerror = (err) => {
            if (this.session !== session) return;
            const msg = err.message || err.type || 'unknown';
            printError(`CRITICAL SYSTEM ERROR: ${msg}`);
            if (err.filename) printError(`  File: ${err.filename}:${err.lineno || ''}:${err.colno || ''}`);
            console.error('[Worker Error]', err);
        };
        worker.addEventListener('messageerror', (err) => {
            console.error('[Worker MessageError]', err);
            printError(`WORKER MESSAGE ERROR: ${err}`);
        });

        validateCircuit(this.canvasManager.components, this.canvasManager.wires);

        // Shared memory: what the circuit drives onto inputs (read by the program) and the levels the
        // program drives onto outputs (read here). Debugger and RPC buffers are per language.
        let debugBuffer = null;
        if (canShare) {
            this.sharedBuffer = new SharedArrayBuffer(SHARED_PINS_LENGTH * 4);
            this.sharedPins = new Int32Array(this.sharedBuffer);
            initSharedMemory(this.sharedPins);
            if (program.language === 'python') debugBuffer = initDebugState();
            if (program.language === 'c') session.rpcBuffer = createMailbox();
            // The worker solves the circuit itself (reads of its input pins), so it needs the circuit too.
            session.circuitBuffer = createCircuitBuffer();
            this.circuitPublished = null;
            this._publishCircuit(true);
        } else {
            printWarning('Limited mode: this page is not cross-origin isolated (no SharedArrayBuffer). C programs cannot run, and button presses, interrupts and the debugger cannot reach a running Python program. Serve the app with the headers in docs/deployment.md.');
        }

        worker.postMessage({
            type: COMMAND.INIT,
            sharedPins: this.sharedBuffer,
            circuitBuffer: session.circuitBuffer || null,
            debugBuffer,
            rpcBuffer: session.rpcBuffer,
            breakpoints: Array.from(getBreakpoints()),
            clockMode: this.clockMode,
            resetCause: getResetState().lastResetType
        });

        // The first read of an input must already see what the circuit drives (publishes into the new buffer).
        this.updateCircuit();

        worker.postMessage(program.language === 'c'
            ? { type: COMMAND.RUN, moduleJs: program.moduleJs }
            : { type: COMMAND.RUN, code: program.code });

        this.pingInterval = setInterval(() => {
            if (this.worker) this.worker.postMessage({ type: COMMAND.PING, t: performance.now() });
        }, PING_INTERVAL_MS);
        if (this.sharedPins) {
            this.reconcileInterval = setInterval(() => this.reconcileOutputs(), OUTPUT_RECONCILE_MS);
        }
        return true;
    }

    /** Stop the program and reset the simulated hardware. Safe to call at any time. */
    stop() {
        this.runToken++;                                   // cancels a pending compile or restart
        if (this.compileAbort) { this.compileAbort.abort(); this.compileAbort = null; }
        this.restarting = false;
        this._teardownWorker();

        resetDebugger();
        resetGpio();
        this.erroredOutputPins.clear();
        this.erroredInputPins.clear();
        this.drivenInputs.clear();
        resetPwm();
        resetWifi();
        resetFs();         // runtime state only; stored files are kept
        this._resetCircuit();   // the board stays powered: LEDs reflect the circuit with no program running

        printSystem("Simulation Stopped.");
        this._setState('stopped');
    }

    /**
     * The program asked to reset (watchdog_reboot(), reset_usb_boot(), machine.reset()).
     * Like a real reset: RAM and peripherals are cleared, flash (the simulated filesystem) is kept,
     * and the same program starts again from the beginning.
     *
     * @param {number} kind — RESET_SOFT | RESET_WATCHDOG | RESET_POWER_CYCLE (hardware/reset-sim.js)
     */
    restart(kind) {
        const session = this.session;
        if (!session || this.restarting) return;

        const now = performance.now();
        this.resetTimes = this.resetTimes.filter(t => now - t < RESET_LOOP_WINDOW_MS);
        this.resetTimes.push(now);
        if (this.resetTimes.length > RESET_LOOP_LIMIT) {
            printError('The program keeps resetting itself - stopped.');
            this.stop();
            return;
        }

        const token = ++this.runToken;
        this.restarting = true;
        this._teardownWorker();

        const result = performReset(kind);
        this._resetCircuit();
        printSystem(`${result.label} — restarting firmware...`);

        const delay = Math.max(0, MIN_RESTART_INTERVAL_MS - (now - session.startedAt));
        setTimeout(() => {
            if (token !== this.runToken) return;           // Stop (or Run) happened meanwhile
            this.restarting = false;
            this._launch(session.program);
        }, delay);
    }

    // ───────────────────────── worker messages ─────────────────────────

    _onWorkerMessage(session, message) {
        if (this.session !== session || message === null || typeof message !== 'object') return;   // late message from a dead worker

        if (message.type === EVENT.RPC) {
            this._handleRpc(session, message);
            return;
        }
        if (message.type !== EVENT.BATCH || !Array.isArray(message.events)) return;

        this.circuitDirty = false;
        for (const event of message.events) {
            this._handleEvent(event);
            if (this.session !== session) return;          // an event stopped or restarted the program
        }
        if (this.circuitDirty) this.updateCircuit();       // once per batch, not once per event
    }

    _handleEvent(event) {
        switch (event.type) {
            case EVENT.STDOUT:
            case EVENT.STDERR:
                print(String(event.text).replace(/\n$/, ""));
                break;

            case EVENT.PIN_CREATE:
                initializePin(event.pin, event.mode);
                configurePull(event.pin, event.pull);
                this.warnIfUnwired(event.pin, event.mode === 1);
                this.circuitDirty = true;
                break;

            case EVENT.PIN_INIT:
                initializePin(event.pin, 0);
                if (event.pull !== undefined) configurePull(event.pin, event.pull);
                handlePinAction(event.pin, 'OFF');
                this.circuitDirty = true;
                break;

            case EVENT.PIN_DIR:
                initializePin(event.pin, event.dir);
                this.warnIfUnwired(event.pin, event.dir === GPIO_OUT);
                this.circuitDirty = true;
                break;

            case EVENT.PIN_PULL:
                configurePull(event.pin, event.pull);
                this.circuitDirty = true;
                break;

            case EVENT.PIN_WRITE:
                handlePinAction(event.pin, event.value ? 'ON' : 'OFF');
                this.warnIfUnwired(event.pin, true);
                this.circuitDirty = true;
                break;

            case EVENT.PIN_FUNC:
                this.pinFunctions[event.pin] = event.fn;
                this.circuitDirty = true;
                break;

            case EVENT.PIN_IRQ:
            case EVENT.IRQ_FIRED:
                break;                 // interrupts are handled inside the firmware worker; these events are informational

            case EVENT.PWM:
                if (event.op === 'wrap') pwmSetWrap(event.slice, event.value);
                else if (event.op === 'level') pwmSetChanLevel(event.slice, event.channel, event.value);
                else if (event.op === 'enable') pwmSetEnabled(event.slice, event.value);
                else if (event.op === 'clkdiv') pwmSetClkdiv(event.slice, event.value);
                this.circuitDirty = true;
                break;

            case EVENT.PROGRAM_ERROR:
                printError(`${event.name}: ${event.message}`);
                break;

            case EVENT.DEBUG_PAUSED:
                handleWorkerPaused(event.line);
                onDebuggerHit(event.line);
                break;

            case EVENT.RESET:
                this.restart(event.kind);
                break;

            case EVENT.OVERFLOW:
                printSystem(`The program produced output faster than it can be shown; ${event.dropped} item(s) were dropped.`);
                break;

            case EVENT.PONG:
                reportWorkerLatency(performance.now() - event.t);
                break;

            default:
                console.warn('[SimulatorBridge] unknown worker event:', event);
        }
    }

    /** Answer a blocking request from the C worker (see rpc-mailbox.js). */
    _handleRpc(session, message) {
        let result = null;
        try {
            result = this._rpc(String(message.op), Array.isArray(message.args) ? message.args : []);
        } catch (err) {
            console.error('[SimulatorBridge] rpc failed:', message.op, err);
        }
        if (session.rpcBuffer) respond(session.rpcBuffer, result === undefined ? null : result);
    }

    _rpc(op, args) {
        switch (op) {
            case 'wifi.init': return wifiInit();
            case 'wifi.deinit': wifiDeinit(); return null;
            case 'wifi.enableSta': wifiEnableStaMode(); return null;
            case 'wifi.connect': return wifiConnect(String(args[0] ?? ''), String(args[1] ?? ''), Number(args[2]) || 0);
            case 'reset.watchdogCaused': return wasWatchdogReset();
            case 'fs.init': return fsInit();
            case 'fs.write': return fsWrite(String(args[0] ?? ''), String(args[1] ?? ''));
            case 'fs.read': return fsRead(String(args[0] ?? ''), Number(args[1]) || 0);
            case 'fs.exists': return fsExists(String(args[0] ?? ''));
            case 'fs.delete': return fsDelete(String(args[0] ?? ''));
            default:
                console.warn('[SimulatorBridge] unknown rpc:', op);
                return null;
        }
    }

    /**
     * Make the pin levels match what the program last wrote, even if some pin events were
     * collapsed or delayed because the program flooded the channel (see event-batcher.js).
     */
    reconcileOutputs() {
        if (!this.sharedPins) return;
        let changed = false;
        for (let pin = 0; pin < NUM_GPIO; pin++) {
            const level = Atomics.load(this.sharedPins, SHARED_OUTPUT_BASE + pin);
            if ((level === 0 || level === 1) && isOutputHigh(pin) !== (level === 1)) {
                handlePinAction(pin, level ? 'ON' : 'OFF');
                changed = true;
            }
        }
        if (changed) this.updateCircuit();
    }

    /** Tell a running Python program about the current breakpoint set. */
    updateBreakpoints() {
        if (this.session && this.session.language === 'python') {
            this.worker.postMessage({ type: COMMAND.BREAKPOINTS, lines: Array.from(getBreakpoints()) });
        }
    }

    // ───────────────────────── circuit ─────────────────────────

    /**
     * Handles when a push button is pressed or released.
     * Updates visual state, component state, and notifies worker.
     *
     * @param {string} componentId - The button's component ID
     * @param {boolean} isPressed - True if pressed, false if released
     */
    handleButtonPress(componentId, isPressed) {
        const btn = this.canvasManager.components.find(c => c.id === componentId);
        if (!btn) return;

        // Update component state
        btn.isPressed = isPressed;

        // Update visual state
        setPushButtonPressed(btn, isPressed);

        // Re-evaluate the circuit (a button changes which nets are connected). This also
        // republishes what every wired GPIO input is driven to.
        this.updateCircuit();
    }

    /**
     * Gives the running worker the current circuit (parts, wires, pressed buttons) through shared memory, so its
     * own solver sees edits and button presses even while the program is busy in a loop. Only writes when
     * something changed.
     */
    _publishCircuit(force) {
        const session = this.session;
        if (!session || !session.circuitBuffer) return;
        const snapshot = snapshotCircuit(this.canvasManager.components, this.canvasManager.wires);
        const text = JSON.stringify(snapshot);
        if (!force && text === this.circuitPublished) return;
        try {
            writeCircuit(session.circuitBuffer, snapshot);
            this.circuitPublished = text;
        } catch (err) {
            printError(`The circuit could not be shared with the program: ${err.message}`);
        }
    }

    /** GPIO numbers that have at least one wire attached. */
    _wiredGpios() {
        const wired = new Set();
        for (const wire of this.canvasManager.wires) {
            for (const node of [wire.start, wire.end]) {
                if (node.nodeType !== 'gpio') continue;
                const pinDef = resolvePinDef(node.pin);
                if (!pinDef || !GPIO_PIN_TYPES.includes(pinDef.type)) continue;
                wired.add(extractGpioNumber(pinDef));
            }
        }
        return wired;
    }

    /**
     * What every header pad is doing right now, as the electrical engine wants it. Direction, level, pull and
     * PWM come from the main-thread mirror of the firmware's hardware state (gpio-sim / pwm-sim).
     * A pin the program has not configured yet is in its reset state: an input with the pull-down enabled.
     */
    _collectPads() {
        const pads = {};
        for (const gpio of this.headerGpios) {
            const state = queryPinState(gpio);
            if (!state) continue;
            const pwm = this.pinFunctions[gpio] === 4;           // function select PWM: the slice drives the pad (duty 0 = held low)
            const pull = !state.initialized ? 'down' : state.pull === PULL_UP ? 'up' : state.pull === PULL_DOWN ? 'down' : 'none';
            pads[gpio] = {
                mode: pwm || state.direction === GPIO_OUT ? 'output' : 'input',
                level: state.outputValue,
                pull
            };
            if (pwm) pads[gpio].duty = getPwmDutyCycle(gpio);
        }
        return pads;
    }

    /**
     * Publishes what the circuit drives onto every GPIO that has a wire (to the state engine and to the
     * firmware worker's shared buffer): 0 or 1 when the pin's net reaches ground, a rail or an output pad
     * (the level is the pad's threshold reading of the solved voltage), or "floating" when only its own pull
     * resistor holds it. The firmware applies the pull itself, which it knows before the main thread does.
     * A GPIO that lost its last wire goes back to floating.
     */
    _publishInputs(result) {
        const seen = this._wiredGpios();
        for (const gpNum of seen) {
            const pad = result.pads[gpNum];
            if (!pad) continue;
            updateInputState(gpNum, pad.driven ? pad.read : null, this.sharedPins, this.worker);
        }
        for (const gpNum of this.drivenInputs) {
            if (!seen.has(gpNum)) updateInputState(gpNum, null, this.sharedPins, this.worker);
        }
        this.drivenInputs = seen;
    }

    /**
     * Warns (once per pin) when a pin the program configured has nothing wired to it. This used to stop the
     * simulation; an unwired pin is legal on a real board, so it is now only a warning.
     */
    warnIfUnwired(gpNum, isOutput) {
        if (isNaN(gpNum) || gpNum < 0 || gpNum > 29) return;
        const reported = isOutput ? this.erroredOutputPins : this.erroredInputPins;
        if (reported.has(gpNum)) return;
        if (this._wiredGpios().has(gpNum)) return;
        reported.add(gpNum);
        printWarning(isOutput
            ? `GP${gpNum} is set as an output but nothing is wired to it.`
            : `GP${gpNum} is set as an input and nothing is wired to it (it will read the value of its pull resistor).`);
    }

    /**
     * Solves the circuit and updates everything that depends on it: LED brightness (from the LED's
     * current), the inputs the program reads, warnings, the status badge and the properties readout.
     *
     * If the circuit cannot be solved the previous valid picture stays on screen and the failure is
     * reported in the console and on the status badge: it is never hidden.
     */
    updateCircuit() {
        const startTime = performance.now();
        const components = this.canvasManager.components;

        this._publishCircuit(false);
        const out = this.engine.update({ components, wires: this.canvasManager.wires, pads: this._collectPads() });

        for (const w of out.added) {
            const key = warningKey(w);
            if (this.printedWarnings.has(key)) continue;
            this.printedWarnings.add(key);
            (w.severity === 'error' ? printError : printWarning)(w.message);
        }
        this._showCircuitStatus(out);

        if (!out.stale && out.result) {
            for (const led of partsOfType(components, 'led')) {
                const part = out.result.parts[led.id];
                setLedBrightness(led, part ? ledBrightness(part.current) : 0);
            }
            this._publishInputs(out.result);
            if (this.canvasManager.setElectricalState) this.canvasManager.setElectricalState(out.result);
        }

        reportPropagationTime(performance.now() - startTime);
    }

    /** The badge in the console header: hidden when the circuit is fine, otherwise says what is wrong. */
    _showCircuitStatus(out) {
        const badge = document.getElementById('circuit-status');
        if (!badge) return;
        const text = badge.querySelector('[data-role="text"]') || badge;      // the pill keeps its icon next to the text
        if (out.warnings.length === 0) {
            badge.classList.add('hidden');
            text.textContent = '';
            badge.title = '';
            return;
        }
        const hasError = out.warnings.some(w => w.severity === 'error');
        badge.classList.remove('hidden');
        badge.dataset.severity = hasError ? 'error' : 'warning';
        badge.classList.toggle('pill--error', hasError);
        badge.classList.toggle('pill--warn', !hasError);
        text.textContent = out.stale
            ? 'Circuit could not be solved'
            : `${out.warnings.length} circuit ${out.warnings.length === 1 ? 'warning' : 'warnings'}`;
        badge.title = out.warnings.map(w => w.message).join('\n');
    }
}

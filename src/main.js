/**
 * This is the main file for the application.
 * It sets up the editor, buttons, and the circuit board.
 * It connects the visual parts to the simulation logic.
 */

import { CanvasManager } from './ui/canvas/canvas-manager.js';
import { SimulatorBridge, isCCode } from './bridge/simulator-bridge.js';
import { LEFT_PINS, RIGHT_PINS } from './circuit/board-pin-layout.js';
import { buildDiagram } from './circuit/diagram.js';
import * as wireRegistry from './circuit/wire-registry.js';
import { createProject, load, shareProject, loadFromURL, getLastImportError, getLastImportNotes, getLastLoadedFrom, chooseStorage, createAutosave } from './project/project-store.js';
import { printError, printSystem, clearSerial } from './ui/panels/serial-output.js';
import { pauseExecution, resumeExecution, stepExecution, setDebuggerUICallback, toggleBreakpoint, getBreakpoints, setOnStateChange } from './debug/debugger.js';
import { init as initInspector, show as showInspector, hide as hideInspector, toggle as toggleInspector, scheduleUpdate as updateInspector, forceUpdate as forceInspectorUpdate } from './ui/panels/state-inspector.js';
import { init as initPerfMonitor, startTracking as startPerfTracking, stopTracking as stopPerfTracking, togglePanel as togglePerfPanel, hidePanel as hidePerfPanel } from './ui/panels/performance-monitor.js';
import { handleSaveCode, handleShareProject } from './ui/project-actions.js';
import { initTooltips } from './ui/tooltip.js';
import { initPopovers, togglePopover } from './ui/popover.js';
import { initMenu } from './ui/menu.js';
import { initSplitters, initPaneSwitch, initConsole } from './ui/layout.js';
import { defineVoltloomThemes, editorThemeFor, EDITOR_FONT } from './ui/editor-theme.js';
import { initTheme, getThemePref, setThemePref, resolveTheme, onThemeChange } from './ui/theme.js';
import { setIcon } from './ui/icons.js';

// Global Instances
let canvasManager;
let simulatorBridge;
let editor;
let consoleUi;
let autosave = null;          // see project/autosave.js: writes the project to browser storage and reports honestly
let restoring = false;        // true while a project is being rebuilt (those edits are not user changes)
let ignoreEdits = false;      // true while the editor text is replaced by the app itself (tab switch, diagram refresh)

const byId = (id) => document.getElementById(id);

/** The user changed something: the project is no longer the saved copy. */
function markUnsaved() {
    if (restoring) return;
    if (autosave) autosave.markDirty();
    hideNotice();
}

/** Show the autosave state in the header. The tooltip carries the full sentence. */
function renderSaveStatus(status) {
    const el = byId('save-status');
    if (!el) return;
    const time = status.savedAt ? new Date(status.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const label = {
        idle: '',
        unsaved: 'Unsaved changes',
        saving: 'Saving…',
        saved: time ? `Saved ${time}` : 'Saved',
        failed: 'Not saved',
        unavailable: 'Autosave off'
    }[status.state] || '';
    el.textContent = label;
    el.title = status.message || '';
    el.dataset.state = status.state;
    el.dataset.storage = status.kind || '';
    el.classList.toggle('hidden', label === '');
}

// Settings
let currentTab = 'main';
let mainViewState = null;     // cursor and scroll of the code tab, kept while the diagram tab is shown
// The program a new project starts with: it needs no parts (the Pico W's own LED), so it runs as soon as it is opened.
const STARTER_CODE = `from machine import Pin
import time

# Blinks the Pico W's own LED. Use "Add part" to put
# parts on the board, wire them, then drive them here.
led = Pin("LED", Pin.OUT)

while True:
    led.toggle()
    print("LED is", "on" if led.value() else "off")
    time.sleep(0.5)
`;
let pythonCode = STARTER_CODE;

// ───────────────────────── the code text, whatever tab is showing ─────────────────────────

/** The program text. On the diagram tab the editor shows generated JSON, so the program is the remembered code. */
function getCode() {
    return editor && currentTab === 'main' ? editor.getValue() : pythonCode;
}

function languageOf(code) {
    return isCCode(code) ? 'c' : 'python';
}

/** Replace the editor text without counting it as a user edit. */
function setEditorText(text) {
    ignoreEdits = true;
    try { editor.setValue(text); } finally { ignoreEdits = false; }
}

function initApp() {
    console.log("Initializing Voltloom...");

    // Interface behaviour that does not depend on the simulator
    initTheme();
    setupThemeMenu();
    initTooltips();
    initPopovers();
    initSplitters();
    initPaneSwitch();
    consoleUi = initConsole({ onClear: clearSerial });

    // UI Elements
    const boardContainer = byId("board-container");
    const simulationArea = byId("simulation-area");
    const outputElement = byId("output");

    // Initialize Managers
    canvasManager = new CanvasManager(boardContainer, simulationArea);
    canvasManager.init();

    simulatorBridge = new SimulatorBridge(canvasManager, outputElement);

    // Initialize state inspector
    const inspectorPanel = byId('state-inspector-panel');
    initInspector(inspectorPanel, canvasManager);

    // Wire state inspector to debugger state changes
    setOnStateChange((event) => {
        if (event === 'paused' || event === 'step') {
            forceInspectorUpdate();
        } else if (event === 'reset') {
            hideInspector();
        }
    });

    // Initialize performance monitor
    const perfPanel = byId('perf-panel');
    initPerfMonitor(perfPanel);

    // Connect button press callback to SimulatorBridge
    // This allows button presses to update GPIO inputs
    simulatorBridge.setupButtonCallback();

    // Link Circuit Change to Simulator Update
    canvasManager.onCircuitChange = () => {
        simulatorBridge.circuitEdited();
        updateDiagramEditor();
        markUnsaved();
    };

    setupEditor();
    setupUI();

    // Load Board, then restore project from URL or session
    canvasManager.loadBoardSVG().then(() => {
        canvasManager.updateTransform();
        // A share link takes priority; otherwise the copy autosave left in this browser
        const urlProject = loadFromURL();
        const linkError = urlProject ? null : getLastImportError();
        if (linkError) printError(`Project link rejected: ${linkError}`);
        const savedProject = urlProject || load();
        if (savedProject) {
            for (const note of getLastImportNotes()) printSystem(`Project: ${note}.`);
            restoreProject(savedProject);
            showRestoreNotice(savedProject, urlProject ? 'link' : 'session');
            if (urlProject) {
                autosave.markDirty();                                   // from a link: not stored yet
            } else {
                printSystem(`Restored your last session (${getLastLoadedFrom() === 'session' ? 'saved for this tab' : 'saved in this browser'}).`);
                autosave.adoptSaved(savedProject.meta && savedProject.meta.savedAt);
            }
        }
        // Frame the circuit unless the viewer already chose a viewport (then it is left exactly as it was)
        canvasManager.settleInitialView();
        canvasManager.refreshHint();
    });

    // Without cross-origin isolation the app still runs Python, but live input does not reach a running program: say so.
    if (!window.crossOriginIsolated) {
        const badge = byId('isolation-status');
        if (badge) {
            badge.classList.remove('hidden');
            badge.title = 'This page is not cross-origin isolated (no SharedArrayBuffer): C programs cannot run, and button presses, interrupts and the debugger cannot reach a running Python program. Serve the app with the headers in docs/deployment.md.';
            badge.onclick = () => togglePopover(badge, {
                title: 'Limited mode',
                iconName: 'alert-triangle',
                paragraphs: [
                    'This page is not cross-origin isolated, so the browser does not provide SharedArrayBuffer.',
                    'C programs cannot run. Button presses, interrupts and the debugger cannot reach a running Python program.',
                    'Serve the app with the headers described in docs/deployment.md.'
                ]
            });
        }
    }

    // Autosave: debounced, written to the best storage that works, and reported truthfully in the header
    autosave = createAutosave({ getProject: (savedAt) => getProject(savedAt), store: chooseStorage(), onStatus: renderSaveStatus });
    window.addEventListener('pagehide', () => autosave.flush());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') autosave.flush(); });

    // Test hook, used only by the browser tests: window.__voltloom gives them the simulator bridge (e.g. to simulate a solver
    // failure), the wire registry (to compare it with the canvas) and a way to build a share link.
    window.__voltloom = {
        bridge: simulatorBridge,
        wireRegistry,
        shareProject: () => {
            const url = shareProject(getProject());
            console.log('[Share] URL:', url);
            return url;
        }
    };
}

// ───────────────────────── editor ─────────────────────────

/** "Ln 4, Col 9", the language, and a note when the text is not the viewer's to edit. */
function updateEditorStatus() {
    const pos = editor ? editor.getPosition() : null;
    byId('status-pos').textContent = pos ? `Ln ${pos.lineNumber}, Col ${pos.column}` : 'Ln 1, Col 1';
    const lang = currentTab === 'diagram' ? 'JSON' : languageOf(getCode()) === 'c' ? 'C' : 'Python';
    byId('status-lang').textContent = lang;
    byId('status-note').textContent = currentTab === 'diagram' ? 'Read-only. Generated from your circuit; change the circuit to change it.' : '';
    byId('tab-main-name').textContent = languageOf(pythonCode) === 'c' ? 'main.c' : 'main.py';
}

/** Highlight the code as the language it is (typing C into a Python file switches it). */
function syncEditorLanguage() {
    if (!editor || currentTab !== 'main') return;
    const wanted = languageOf(editor.getValue());
    if (editor.getModel().getLanguageId() !== wanted) monaco.editor.setModelLanguage(editor.getModel(), wanted);
    pythonCode = editor.getValue();
    updateEditorStatus();
}

let languageTimer = null;
const breakpointDecorations = { set: () => {} };     // replaced when the editor exists
let pausedDecorations = null;

/** Draw the breakpoint dots for the lines the debugger knows (only on the code tab: line numbers mean nothing in the diagram). */
function renderBreakpoints() {
    if (!editor) return;
    const lines = currentTab === 'main' ? [...getBreakpoints()] : [];
    breakpointDecorations.set(lines.map((ln) => ({
        range: new monaco.Range(ln, 1, ln, 1),
        options: { isWholeLine: false, glyphMarginClassName: 'breakpoint-glyph', glyphMarginHoverMessage: { value: 'Breakpoint' } }
    })));
}

/** Mark the line the program is paused on. */
function showPausedLine(line) {
    if (!editor || !pausedDecorations) return;
    if (!line || currentTab !== 'main') { pausedDecorations.set([]); return; }
    pausedDecorations.set([{
        range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: 'paused-line', glyphMarginClassName: 'paused-glyph' }
    }]);
}

function showEditorError(message) {
    const state = byId('editor-state');
    state.hidden = false;
    state.innerHTML = '<div class="empty empty--error"><span class="empty__title">The editor could not be loaded</span><p></p></div>';
    state.querySelector('p').textContent = message;
}

function setupEditor() {
    // The Monaco loader defines a global AMD `require`. Ask the window for it: inside the production bundle a bare `require`
    // can be the bundler's own stand-in, which exists even when the loader (a CDN script) never arrived.
    const amdRequire = window.require;
    if (typeof amdRequire !== 'function' || typeof amdRequire.config !== 'function') {
        showEditorError('The editor comes from cdnjs.cloudflare.com, which could not be reached. Check your connection and reload; your circuit still works.');
        return;
    }
    amdRequire.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' } });
    amdRequire(['vs/editor/editor.main'], function () {
        const container = byId('editor-container');
        if (!container) return;
        defineVoltloomThemes(monaco);
        editor = monaco.editor.create(container, {
            value: pythonCode,
            language: languageOf(pythonCode),          // a project restored before the editor was ready may be C
            theme: editorThemeFor(resolveTheme()),
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 14,
            fontFamily: EDITOR_FONT,
            lineHeight: 22,
            padding: { top: 12, bottom: 12 },
            glyphMargin: true,                         // Essential for breakpoints
            scrollBeyondLastLine: false,
            renderLineHighlight: 'line',
            ariaLabel: 'Code editor'
        });
        byId('editor-state').hidden = true;

        // The font arrives from Google Fonts after the editor exists: measure again so the cursor lines up with the text
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => monaco.editor.remeasureFonts());

        const collection = editor.createDecorationsCollection([]);
        breakpointDecorations.set = (decorations) => collection.set(decorations);
        pausedDecorations = editor.createDecorationsCollection([]);
        renderBreakpoints();

        // Handle clicking in the margin to set breakpoints
        editor.onMouseDown((e) => {
            if (currentTab !== 'main') return;
            if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
                toggleBreakpoint(e.target.position.lineNumber);
                simulatorBridge.updateBreakpoints();   // a running Python program must learn about it
                renderBreakpoints();
            }
        });

        editor.onDidChangeCursorPosition(updateEditorStatus);

        // Auto-save on code change
        editor.onDidChangeModelContent(() => {
            if (ignoreEdits) return;
            markUnsaved();
            clearTimeout(languageTimer);
            languageTimer = setTimeout(syncEditorLanguage, 300);
        });

        // Ctrl/Cmd+Enter runs the program from inside the editor too
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => requestRun());

        updateEditorStatus();
    }, function (err) {
        console.error('[Editor] failed to load Monaco', err);
        showEditorError('The editor comes from cdnjs.cloudflare.com, which could not be reached. Check your connection and reload; your circuit still works.');
    });
}

// ───────────────────────── transport: Run, Stop and the debugger ─────────────────────────

// phase: 'idle' | 'starting' (compiling C) | 'running' | 'paused'
const transport = { phase: 'idle', language: 'python', line: null, errorsAtStart: 0, userStopped: false, label: 'Ready', tone: 'idle' };

function renderTransport() {
    const { phase, language } = transport;
    const idle = phase === 'idle';
    const python = language === 'python';
    const paused = phase === 'paused';

    const run = byId('run-btn');
    const stop = byId('stop-btn');
    run.disabled = !idle;
    stop.disabled = idle;
    stop.classList.toggle('is-live', !idle);

    const pause = byId('pause-btn');
    const resume = byId('resume-btn');
    const step = byId('step-btn');
    pause.disabled = !(phase === 'running' && python);
    pause.dataset.tipDisabled = idle ? 'Available while a Python program runs'
        : python ? 'Available once the program is running' : 'The debugger is only available for Python programs';
    pause.classList.toggle('hidden', paused);
    resume.classList.toggle('hidden', !paused);
    resume.disabled = !paused;
    step.disabled = !paused;
    step.dataset.tipDisabled = 'Available while the program is paused';

    const inspector = byId('inspector-toggle-btn');
    inspector.disabled = idle;
    inspector.dataset.tipDisabled = 'Available while a program runs';
    const stats = byId('perf-toggle-btn');
    stats.disabled = idle;
    stats.dataset.tipDisabled = 'Available while a program runs';

    const lang = python ? 'Python' : 'C';
    const status = byId('run-status');
    let text = transport.label;
    let state = transport.tone;
    if (phase === 'starting') { text = `Compiling ${lang}…`; state = 'starting'; }
    else if (phase === 'running') { text = `Running · ${lang}`; state = 'running'; }
    else if (paused) { text = transport.line ? `Paused · line ${transport.line}` : 'Paused'; state = 'paused'; }
    status.dataset.state = state;
    byId('run-status-text').textContent = text;
}

function setPhase(phase, extra = {}) {
    Object.assign(transport, extra, { phase });
    renderTransport();
}

/** UI while a program is starting or running. The debugger buttons only apply to Python. */
function applyRunningUi(isC) {
    transport.errorsAtStart = byId('output').querySelectorAll('.line--error').length;
    transport.userStopped = false;
    setPhase(isC ? 'starting' : 'running', { language: isC ? 'c' : 'python', line: null });
    consoleUi.expand();
    startPerfTracking();                       // Start tracking performance
}

/** UI when nothing is running. */
function applyStoppedUi() {
    const failed = byId('output').querySelectorAll('.line--error').length > transport.errorsAtStart;
    const label = failed ? 'Stopped with errors. See the console.' : 'Stopped';
    showPausedLine(null);
    setPhase('idle', { line: null, label, tone: failed ? 'error' : 'idle' });
    hideInspector();                           // Hide inspector panel when simulation stops
    stopPerfTracking();
    hidePerfPanel();
}

function requestRun() {
    if (transport.phase !== 'idle') return;
    const code = getCode();
    const isC = isCCode(code);
    applyRunningUi(isC);
    if (isC) {
        simulatorBridge.runC(code);
    } else {
        simulatorBridge.run(code);
    }
}

// ───────────────────────── wiring the page together ─────────────────────────

function setupUI() {
    // The simulator reports its lifecycle; the buttons follow it. 'stopped' also arrives when a
    // compile fails, the circuit is incomplete, or a program is stopped from anywhere else.
    simulatorBridge.onStateChange = (state) => {
        if (state === 'stopped') applyStoppedUi();
    };
    simulatorBridge.onPhaseChange = (phase) => {
        if (transport.phase === 'idle') return;
        if (phase === 'compiling') setPhase('starting', { language: 'c' });
        else if (phase === 'running' && transport.phase === 'starting') setPhase('running');
    };

    byId("run-btn").onclick = requestRun;
    byId("stop-btn").onclick = () => {
        transport.userStopped = true;
        simulatorBridge.stop();
    };
    renderTransport();

    // Debugger controls
    byId("pause-btn").onclick = () => pauseExecution();
    byId("resume-btn").onclick = () => resumeExecution();
    byId("step-btn").onclick = () => stepExecution();

    // Automatically respond to backend pauses (e.g. Breakpoints)
    setDebuggerUICallback((state) => {
        if (transport.phase === 'idle' || transport.phase === 'starting') return;
        if (state.paused) {
            setPhase('paused', { line: state.line || transport.line });
            if (state.line && editor && currentTab === 'main') {
                editor.revealLineInCenter(state.line);
                editor.setPosition({ lineNumber: state.line, column: 1 });
            }
            showPausedLine(state.line || transport.line);
        } else {
            setPhase('running', { line: null });
            showPausedLine(null);
        }
    });

    // State Inspector toggle button
    byId('inspector-toggle-btn').onclick = () => toggleInspector();
    byId('inspector-close-btn').onclick = () => hideInspector();

    // Performance Monitor toggle button
    byId('perf-toggle-btn').onclick = () => togglePerfPanel();

    // Circuit warnings: the pill opens the full list
    const circuitBadge = byId('circuit-status');
    circuitBadge.onclick = () => {
        const isError = circuitBadge.dataset.severity === 'error';
        togglePopover(circuitBadge, {
            title: isError ? 'Circuit problem' : 'Circuit warnings',
            iconName: isError ? 'alert-circle' : 'alert-triangle',
            lines: circuitBadge.title.split('\n').filter(Boolean)
        });
    };

    // Download and Share
    byId('save-code-btn').onclick = () => {
        const code = getCode();
        handleSaveCode(code, isCCode(code) ? 'main.c' : 'main.py');
    };
    byId('share-project-btn').onclick = () => {
        handleShareProject(shareProject(getProject()));
    };

    // Components
    initMenu(byId('add-component-btn'), byId('component-dropdown'));
    byId('add-resistor-btn').onclick = () => canvasManager.addResistor();
    byId('add-led-btn').onclick = () => canvasManager.addLED();
    byId('add-pushbutton-btn').onclick = () => canvasManager.addPushButton();

    // Zoom Controls
    byId('zoom-in-btn').onclick = () => canvasManager.zoomIn();
    byId('zoom-out-btn').onclick = () => canvasManager.zoomOut();
    byId('zoom-level-lbl').onclick = () => canvasManager.resetZoom();
    byId('zoom-fit-btn').onclick = () => canvasManager.fitToContent({ user: true });
    byId('grid-toggle-btn').onclick = () => canvasManager.setGrid(!canvasManager.gridOn);

    // Popup Controls
    const popupValue = byId("popup-value");
    const popupUnit = byId("popup-unit");
    popupValue.oninput = () => canvasManager.updateSelectedComponentValue(popupValue.value, popupUnit.value);
    popupUnit.onchange = () => canvasManager.updateSelectedComponentValue(popupValue.value, popupUnit.value);
    byId("popup-rotate").onclick = () => canvasManager.rotateSelectedComponent();
    byId("popup-flip").onclick = () => canvasManager.flipSelectedComponent();
    byId("popup-delete").onclick = () => canvasManager.deleteSelected();
    byId("led-controls").querySelectorAll('[data-color]').forEach((swatch) => {
        swatch.onclick = () => canvasManager.updateSelectedComponentColor(swatch.getAttribute('data-color'));
    });

    setupKeys();
    setupNewProject();
    setupTabs();
}

/** True when a key press belongs to a text field (or the editor), not to the canvas. */
function isTyping(target) {
    return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"], .monaco-editor');
}

function setupKeys() {
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (canvasManager.wireManager.wireStartNode) {
                canvasManager.wireManager.cancelWire();
            } else if (!isTyping(e.target)) {
                canvasManager.selectComponent(null);
            }
            return;
        }

        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            requestRun();
            return;
        }

        if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
        if (e.target instanceof Element && e.target.closest('dialog[open]')) return;

        switch (e.key) {
            case 'Delete':
            case 'Backspace':
                // while drawing a wire, Backspace takes back the last corner; otherwise it deletes the selection
                if (e.key === 'Backspace' && canvasManager.wireManager.removeLastWaypoint()) break;
                canvasManager.deleteSelected();
                break;
            case 'r': case 'R':
                canvasManager.rotateSelectedComponent();
                break;
            case 'f': case 'F':
                canvasManager.fitToContent({ user: true });
                break;
            case '0':
                canvasManager.resetZoom();
                break;
            case '+': case '=':
                canvasManager.zoomIn();
                break;
            case '-': case '_':
                canvasManager.zoomOut();
                break;
            default:
        }
    });
}

function setupTabs() {
    const main = byId('tab-main');
    const diagram = byId('tab-diagram');
    main.onclick = () => switchTab('main');
    diagram.onclick = () => switchTab('diagram');

    // Arrow keys move between the two tabs, as in any tab list
    for (const tab of [main, diagram]) {
        tab.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            const next = tab === main ? diagram : main;
            next.focus();
            next.click();
            e.preventDefault();
        });
    }
}

function setTabSelection() {
    for (const [id, name] of [['tab-main', 'main'], ['tab-diagram', 'diagram']]) {
        const tab = byId(id);
        tab.setAttribute('aria-selected', String(currentTab === name));
        tab.tabIndex = currentTab === name ? 0 : -1;
    }
}

function switchTab(tabName) {
    if (!editor || currentTab === tabName) return;

    if (currentTab === 'main') {
        pythonCode = editor.getValue();
        mainViewState = editor.saveViewState();
    }

    currentTab = tabName;
    setTabSelection();
    ignoreEdits = true;
    try {
        if (tabName === 'main') {
            monaco.editor.setModelLanguage(editor.getModel(), languageOf(pythonCode));
            editor.updateOptions({ readOnly: false });
            editor.setValue(pythonCode);
            if (mainViewState) editor.restoreViewState(mainViewState);
        } else {
            monaco.editor.setModelLanguage(editor.getModel(), 'json');
            editor.updateOptions({ readOnly: true });
            editor.setValue(generateDiagramJson());
        }
    } finally {
        ignoreEdits = false;
    }
    showPausedLine(null);
    renderBreakpoints();
    updateEditorStatus();
}

// The diagram.json tab: a Wokwi-style description of the parts and wires (built by src/circuit/diagram.js).
function generateDiagramJson() {
    const diagram = buildDiagram(canvasManager.components, canvasManager.wires, [...LEFT_PINS, ...RIGHT_PINS]);
    return JSON.stringify(diagram, null, 2);
}

function updateDiagramEditor() {
    if (currentTab === 'diagram' && editor) {
        const json = generateDiagramJson();
        if (editor.getValue() !== json) {
            // Replace through the model so the viewer's scroll position in the diagram survives live updates
            ignoreEdits = true;
            try { editor.getModel().applyEdits([{ range: editor.getModel().getFullModelRange(), text: json }]); } finally { ignoreEdits = false; }
        }
    }
}

// ─── Project Save & Share Helpers ───────────────────────────────

/**
 * Gathers current project state into a serializable object.
 */
function getProject(savedAt) {
    const code = getCode();
    const language = languageOf(code);
    return createProject(code, language, canvasManager.components, canvasManager.wires, 'pico_w', savedAt ? { savedAt } : {});
}

/**
 * Restores a project from a serialized object.
 * Rebuilds components, wires, and editor code.
 */
function restoreProject(project) {
    if (!project) return;
    restoring = true;
    try {
        rebuildFromProject(project);
    } finally {
        restoring = false;
    }
}

function rebuildFromProject(project) {

    // Restore code
    const code = project.code || '';
    const language = project.language || 'python';
    pythonCode = code;

    if (editor) {
        if (currentTab === 'main') {
            // Set language mode
            monaco.editor.setModelLanguage(editor.getModel(), language === 'c' ? 'c' : 'python');
            setEditorText(code);
        }
        updateEditorStatus();
    }

    // Restore components
    canvasManager.clearAll();
    if (project.components && Array.isArray(project.components)) {
        project.components.forEach(compData => {
            canvasManager.restoreComponent(compData);
        });
    }

    // Restore wires (after components, since wires reference component IDs)
    if (project.connections && Array.isArray(project.connections)) {
        project.connections.forEach(wireData => {
            canvasManager.restoreWire(wireData);
        });
    }

    // The board is powered whenever the page is open: solve the restored circuit right away.
    simulatorBridge.engine.reset();
    simulatorBridge.circuitEdited();
    updateDiagramEditor();

    console.log('[ProjectStore] Project restored:', {
        language,
        components: project.components?.length || 0,
        wires: project.connections?.length || 0
    });
}


// ───────────────────────── theme ─────────────────────────

const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' };
const THEME_NAME = { system: 'System', light: 'Light', dark: 'Dark' };

/** The theme button shows the current choice; its menu is a radio group (System, Light, Dark). */
function setupThemeMenu() {
    const button = byId('theme-btn');
    const menu = byId('theme-menu');
    initMenu(button, menu);
    menu.querySelectorAll('[data-theme-choice]').forEach((item) => {
        item.onclick = () => setThemePref(item.dataset.themeChoice);
    });
    onThemeChange((theme, pref) => {
        setIcon(button.querySelector('svg'), THEME_ICON[pref]);
        const label = pref === 'system' ? `Theme: ${THEME_NAME[theme]} (follows the system)` : `Theme: ${THEME_NAME[pref]}`;
        button.setAttribute('aria-label', label);
        button.dataset.tip = label;
        menu.querySelectorAll('[data-theme-choice]').forEach((item) => item.setAttribute('aria-checked', String(item.dataset.themeChoice === pref)));
        // the editor follows (Monaco has its own theme registry); nothing else needs to know: the page restyles itself
        if (editor && window.monaco) window.monaco.editor.setTheme(editorThemeFor(theme));
    });
}

// ───────────────────────── restore notice and New project ─────────────────────────

function hideNotice() {
    const notice = byId('canvas-notice');
    if (notice) notice.hidden = true;
}

/** Say that the circuit on screen came from a saved session or a link, so its parts never appear unexplained. */
function showRestoreNotice(project, source) {
    const parts = (project.components || []).length;
    const wires = (project.connections || []).length;
    if (parts + wires === 0) return;                  // an empty circuit has nothing that could appear unexplained
    const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const text = byId('canvas-notice-text');
    text.textContent = source === 'link' ? 'Opened a shared project' : 'Restored your last session';
    const detail = document.createElement('small');
    detail.textContent = `${count(parts, 'part')}, ${count(wires, 'wire')}`;
    text.append(detail);
    byId('canvas-notice').hidden = false;
}

function setupNewProject() {
    const dialog = byId('new-project-modal');
    const open = () => {
        const parts = canvasManager.components.length;
        const wires = canvasManager.wires.length;
        byId('new-project-text').textContent = parts + wires === 0
            ? 'This resets the code to the starter program. The circuit is already empty.'
            : `This replaces the current circuit (${parts} part${parts === 1 ? '' : 's'}, ${wires} wire${wires === 1 ? '' : 's'}) and code with an empty board and a starter program.`;
        dialog.showModal();
        byId('new-project-cancel').focus();          // the safe choice has focus
    };
    byId('new-project-btn').onclick = open;
    // The notice is one-time information: it goes as soon as the viewer starts working, so it never sits on top of
    // the properties card or the stats card.
    byId('simulation-area').addEventListener('pointerdown', (e) => { if (!e.target.closest('#canvas-notice')) hideNotice(); }, true);
    for (const id of ['run-btn', 'add-component-btn']) byId(id).addEventListener('click', hideNotice);
    byId('notice-new-btn').onclick = open;
    byId('notice-close-btn').onclick = hideNotice;
    byId('new-project-cancel').onclick = () => dialog.close();
    byId('new-project-close').onclick = () => dialog.close();
    dialog.onclick = (e) => { if (e.target === dialog) dialog.close(); };
    byId('new-project-confirm').onclick = () => { dialog.close(); startNewProject(); };
}

/** Replace the project with an empty board and the starter program, and store that, so a reload stays empty. */
function startNewProject() {
    if (transport.phase !== 'idle') { transport.userStopped = true; simulatorBridge.stop(); }
    restoring = true;
    try {
        canvasManager.clearAll();
        getBreakpoints().clear();
        renderBreakpoints();
        pythonCode = STARTER_CODE;
        mainViewState = null;
        if (editor) {
            if (currentTab !== 'main') switchTab('main');
            monaco.editor.setModelLanguage(editor.getModel(), 'python');
            setEditorText(STARTER_CODE);
            editor.setPosition({ lineNumber: 1, column: 1 });
        }
        simulatorBridge.engine.reset();
        simulatorBridge.circuitEdited();
        updateDiagramEditor();
    } finally {
        restoring = false;
    }
    clearSerial();
    hideNotice();
    setPhase('idle', { label: 'Ready', tone: 'idle' });
    updateEditorStatus();
    canvasManager.fitToContent();
    canvasManager.refreshHint();
    autosave.markDirty();
    autosave.saveNow();                               // stored at once: a reload must not bring the old project back
    printSystem('Started a new project.');
}

// Boot
document.addEventListener('DOMContentLoaded', initApp);

# Getting started

This guide assumes Voltloom is installed and running (`npm run dev`, then http://localhost:5173/). For installation see the [README](../README.md#getting-started-on-windows); for problems see [setup-and-troubleshooting.md](setup-and-troubleshooting.md).

## Your first circuit: a blinking LED

A new project opens with an empty Pico board and a starter program that blinks the Pico W's own on-board LED. To drive an LED you wire yourself:

1. **Add the parts.** Use **Add part** in the canvas toolbar to place a **Resistor** and an **LED**. New parts land beside the board.
2. **Wire GP15 to the resistor.** Click the **GP15** pin on the board (the bottom-left pin, number 20; hover a pin to see its name). Then click one end of the resistor.
   - While a wire is being drawn, the pin under the pointer turns green if the connection is allowed, or red if it is not (for example an LED's anode straight to GND).
   - To give a wire a shape of your own, click empty canvas to drop corners on the way, as in Wokwi. **Backspace** removes the last corner, and **Esc** or a right-click cancels the wire.
3. **Wire the resistor to the LED anode** (the bent leg, marked *A* in its tooltip).
4. **Wire the LED cathode** (*C*) to any **GND** pin.
5. **Replace the program** with:

   ```python
   from machine import Pin
   from time import sleep

   led = Pin(15, Pin.OUT)

   while True:
       led.toggle()
       sleep(0.5)
   ```

6. Press **Run** (or **Ctrl+Enter**). The LED blinks every half second, and **Stop** ends the program.

Click the resistor and change its value in its card: the LED's current, shown in the same card, and its brightness follow. Make the value very small and the circuit warns that the GPIO pin is overloaded.

## A tour of the workbench

![The Voltloom workbench in the light theme](assets/light-theme.png)

### Title bar
- **Run / Stop.** Run starts the program on the simulated board. Ctrl+Enter does the same, from the editor too.
- **Pause, Resume, Step** (Python only). Pause stops at the next line; Step runs one line and pauses again.
- **Status.** Ready, Compiling (C), Running, Paused at line N, or Stopped.
- **Autosave status.** Your project is saved in this browser automatically. Opening Voltloom again restores your last session, and the canvas says so.
- **New.** An empty board and the starter program, after a confirmation.
- **Download.** Saves the program as `main.py` or `main.c`.
- **Theme.** System, Light or Dark. System follows your operating system.
- **Share.** A link that contains the whole project: code, parts and wires. Nothing is uploaded.

### Code (left)
- The Monaco editor. Click the gutter to set a **breakpoint** (Python).
- The **diagram.json** tab shows the circuit as generated, read-only text, in the format Wokwi uses.
- The status bar shows the cursor position and the language: Python or C, detected from the code.

### Circuit (right)
- **Add part:** resistor, LED, push button.
- **Select** a part or a wire to open its card.
  - Parts: value (resistor), colour (LED and wire), rotate, flip (LED), delete.
  - While a program runs, the card shows the part's current, voltage and power.
- **Press a push button** with the mouse while a program runs.
- **Reshape a wire:** select it, then drag the round handles (bends) or the square handles (segments). Double-click a selected wire to add a bend. Wires always stay horizontal and vertical, and their ends stay on their pins.
- **Inspector** (while running): pin directions and levels, PWM, execution state and parts.
- **Stats** (while running): frame rate, circuit-solve time and worker latency.
- **Grid:** an optional placement grid, off by default.
- **Zoom:** −, the zoom level (click it for 100%), +, and Fit.

The **console** under the canvas shows program output, errors and circuit warnings. It opens by itself when you press Run or when an error occurs.

### Keys

Keys work when you are not typing in a field.

| Key | Action |
|---|---|
| Ctrl+Enter | Run |
| R | rotate the selected part |
| Delete / Backspace | delete the selected part or wire (while drawing a wire, Backspace removes its last corner) |
| Esc | cancel the wire being drawn, or deselect |
| F | fit everything in view |
| 0 | zoom to 100% |
| + / − | zoom in / out |

The mouse wheel zooms about the pointer; drag the background to pan. Drag the splitters (or focus one and use the arrow keys, Home and End) to resize the panes. Sizes, the canvas view, the theme and the grid setting are remembered in this browser. On windows narrower than 900 px, a **Code / Circuit** switch shows one pane at a time.

## Running C programs

Start the compile service in a second terminal (`npm run compiler`, with Emscripten installed; see the [README](../README.md#optional-c-programs-emscripten)). Then paste a C program into the editor. Voltloom recognises C from the code (for example `#include "pico/stdlib.h"` or `int main(`) and compiles it on Run:

```c
#include "pico/stdlib.h"

int main() {
    const uint LED_PIN = 15;
    gpio_init(LED_PIN);
    gpio_set_dir(LED_PIN, GPIO_OUT);
    while (1) {
        gpio_put(LED_PIN, 1);
        sleep_ms(500);
        gpio_put(LED_PIN, 0);
        sleep_ms(500);
    }
}
```

Which SDK calls exist is listed in [sdk-compatibility.md](sdk-compatibility.md). The debugger is not available for C.

## Next steps

- Open the ready-made [examples](examples.md), including the traffic light from the README.
- Read how the circuit is solved in [electrical-model.md](electrical-model.md).
- See how it all fits together in [architecture.md](architecture.md).

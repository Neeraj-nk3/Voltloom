/**
 * This file lists all the pins on the Raspberry Pi Pico.
 * It defines which pins are for Power, Ground, or GPIO.
 * It does NOT contain any code logic, just data.
 */

export const LEFT_PINS = [
    { pin: 1, label: "GP0", type: "GPIO" },
    { pin: 2, label: "GP1", type: "GPIO" },
    { pin: 3, label: "GND.1", type: "Ground" },
    { pin: 4, label: "GP2", type: "GPIO" },
    { pin: 5, label: "GP3", type: "GPIO" },
    { pin: 6, label: "GP4", type: "GPIO" },
    { pin: 7, label: "GP5", type: "GPIO" },
    { pin: 8, label: "GND.2", type: "Ground" },
    { pin: 9, label: "GP6", type: "GPIO" },
    { pin: 10, label: "GP7", type: "GPIO" },
    { pin: 11, label: "GP8", type: "GPIO" },
    { pin: 12, label: "GP9", type: "GPIO" },
    { pin: 13, label: "GND.3", type: "Ground" },
    { pin: 14, label: "GP10", type: "GPIO" },
    { pin: 15, label: "GP11", type: "GPIO" },
    { pin: 16, label: "GP12", type: "GPIO" },
    { pin: 17, label: "GP13", type: "GPIO" },
    { pin: 18, label: "GND.4", type: "Ground" },
    { pin: 19, label: "GP14", type: "GPIO" },
    { pin: 20, label: "GP15", type: "GPIO" }
];

export const RIGHT_PINS = [
    { pin: 40, label: "VBUS", type: "Power" },
    { pin: 39, label: "VSYS", type: "Power" },
    { pin: 38, label: "GND.8", type: "Ground" },
    { pin: 37, label: "3V3_EN", type: "Power" },
    { pin: 36, label: "3V3(OUT)", type: "Power" },
    { pin: 35, label: "ADC_VREF", type: "Power" },
    { pin: 34, label: "GP28", type: "ADC2" },
    { pin: 33, label: "GND.7", type: "Ground" },
    { pin: 32, label: "GP27", type: "ADC1" },
    { pin: 31, label: "GP26", type: "ADC0" },
    { pin: 30, label: "RUN", type: "Control" },
    { pin: 29, label: "GP22", type: "GPIO" },
    { pin: 28, label: "GND.6", type: "Ground" },
    { pin: 27, label: "GP21", type: "GPIO" },
    { pin: 26, label: "GP20", type: "GPIO" },
    { pin: 25, label: "GP19", type: "GPIO" },
    { pin: 24, label: "GP18", type: "GPIO" },
    { pin: 23, label: "GND.5", type: "Ground" },
    { pin: 22, label: "GP17", type: "GPIO" },
    { pin: 21, label: "GP16", type: "GPIO" }
];

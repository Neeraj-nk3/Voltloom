/**
 * Colour tables: resistor colour-band digits and multipliers, and the LED colour choices (light/dark shades).
 */

export const digitColors = {
    0: '#000000', 1: '#8B5B29', 2: '#FF0000', 3: '#FFA500',
    4: '#FFFF00', 5: '#008000', 6: '#0000FF', 7: '#EE82EE',
    8: '#808080', 9: '#FFFFFF'
};

export const multiplierColors = {
    '-2': '#C0C0C0', '-1': '#FFD700', '0': '#000000', '1': '#8B5B29',
    '2': '#FF0000', '3': '#FFA500', '4': '#FFFF00', '5': '#008000',
    '6': '#0000FF', '7': '#EE82EE', '8': '#808080', '9': '#FFFFFF'
};

export const ledColorMap = {
    '#ef4444': { light: '#f87171', dark: '#b91c1c' },
    '#22c55e': { light: '#4ade80', dark: '#15803d' },
    '#3b82f6': { light: '#60a5fa', dark: '#1d4ed8' },
    '#facc15': { light: '#fde047', dark: '#ca8a04' },
    '#f97316': { light: '#fb923c', dark: '#c2410c' },
    '#a855f7': { light: '#c084fc', dark: '#7e22ce' },
    '#ec4899': { light: '#f472b6', dark: '#be185d' },
    '#22d3ee': { light: '#67e8f9', dark: '#0e7490' },
    '#ffffff': { light: '#ffffff', dark: '#e5e5e5' },
    '#a3e635': { light: '#bef264', dark: '#4d7c0f' }
};

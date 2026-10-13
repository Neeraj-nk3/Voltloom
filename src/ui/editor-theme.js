/**
 * editor-theme.js — the Monaco colour themes, one per app theme, built from the same palettes as the rest of the
 * interface (values mirror src/ui/styles/tokens.css; Monaco cannot read CSS variables).
 */

export const EDITOR_FONT = "'JetBrains Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace";

/** Monaco theme name for an app theme ('light' | 'dark'). */
export const editorThemeFor = (theme) => (theme === 'light' ? 'voltloom-light' : 'voltloom-dark');

export function defineVoltloomThemes(monaco) {
    monaco.editor.defineTheme('voltloom-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [
            { token: 'comment', foreground: '8d8a84', fontStyle: 'italic' },
            { token: 'keyword', foreground: 'f0aa76' },
            { token: 'string', foreground: '9bd8a8' },
            { token: 'number', foreground: 'e6c14a' },
            { token: 'type', foreground: '7fc4ea' },
            { token: 'type.identifier', foreground: '7fc4ea' },
            { token: 'delimiter', foreground: 'b4b1ac' },
            { token: 'operator', foreground: 'b4b1ac' },
            { token: 'string.key.json', foreground: '7fc4ea' },
            { token: 'string.value.json', foreground: '9bd8a8' }
        ],
        colors: {
            'editor.background': '#14161a',
            'editor.foreground': '#e9e7e4',
            'editorGutter.background': '#14161a',
            'editor.lineHighlightBackground': '#1b1e23',
            'editor.lineHighlightBorder': '#1b1e23',
            'editor.selectionBackground': '#d98a4e44',
            'editor.inactiveSelectionBackground': '#d98a4e26',
            'editorCursor.foreground': '#f0aa76',
            'editorLineNumber.foreground': '#8d8a84',
            'editorLineNumber.activeForeground': '#e9e7e4',
            'editorIndentGuide.background1': '#262a30',
            'editorIndentGuide.activeBackground1': '#41464f',
            'editorWidget.background': '#1d2024',
            'editorWidget.border': '#41464f',
            'editorSuggestWidget.background': '#1d2024',
            'editorSuggestWidget.selectedBackground': '#272b31',
            'editorHoverWidget.background': '#1d2024',
            'scrollbarSlider.background': '#41464f66',
            'scrollbarSlider.hoverBackground': '#41464faa',
            'scrollbarSlider.activeBackground': '#98958f88',
            'focusBorder': '#f0aa76'
        }
    });

    monaco.editor.defineTheme('voltloom-light', {
        base: 'vs',
        inherit: true,
        rules: [
            { token: 'comment', foreground: '6d685f', fontStyle: 'italic' },
            { token: 'keyword', foreground: '944c18' },
            { token: 'string', foreground: '2b6e3f' },
            { token: 'number', foreground: '7c5500' },
            { token: 'type', foreground: '1f62a3' },
            { token: 'type.identifier', foreground: '1f62a3' },
            { token: 'delimiter', foreground: '5b5750' },
            { token: 'operator', foreground: '5b5750' },
            { token: 'string.key.json', foreground: '1f62a3' },
            { token: 'string.value.json', foreground: '2b6e3f' }
        ],
        colors: {
            'editor.background': '#f8f7f4',
            'editor.foreground': '#1d1c1a',
            'editorGutter.background': '#f8f7f4',
            'editor.lineHighlightBackground': '#efece6',
            'editor.lineHighlightBorder': '#efece6',
            'editor.selectionBackground': '#a85a2230',
            'editor.inactiveSelectionBackground': '#a85a221c',
            'editorCursor.foreground': '#944c18',
            'editorLineNumber.foreground': '#77726a',
            'editorLineNumber.activeForeground': '#1d1c1a',
            'editorIndentGuide.background1': '#e3e0da',
            'editorIndentGuide.activeBackground1': '#c3beb4',
            'editorWidget.background': '#fcfbf9',
            'editorWidget.border': '#c3beb4',
            'editorSuggestWidget.background': '#fcfbf9',
            'editorSuggestWidget.selectedBackground': '#ebe8e2',
            'editorHoverWidget.background': '#fcfbf9',
            'scrollbarSlider.background': '#c3beb466',
            'scrollbarSlider.hoverBackground': '#c3beb4aa',
            'scrollbarSlider.activeBackground': '#898378aa',
            'focusBorder': '#944c18'
        }
    });
}

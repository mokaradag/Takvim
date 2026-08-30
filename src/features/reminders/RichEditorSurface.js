import { createElement, forwardRef } from 'react';

/**
 * Zengin metin düzenleyicisinin düzenlenebilir yüzeyini ortak erişilebilirlik özellikleriyle sunar.
 */
export const RichEditorSurface = forwardRef(function RichEditorSurface({
  disabled = false,
  ariaLabel = 'E-posta gövdesi',
  onInput,
  onBlur,
  onPaste
}, ref) {
  return createElement('div', {
    ref,
    className: 'rich-editor-surface',
    contentEditable: !disabled,
    suppressContentEditableWarning: true,
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-disabled': disabled,
    'aria-label': ariaLabel,
    onInput,
    onBlur,
    onPaste
  });
});

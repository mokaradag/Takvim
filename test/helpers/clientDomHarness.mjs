import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { CLIENT_STATE } from './clientComponentHarness.mjs';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true
});
for (const key of [
  'window',
  'document',
  'HTMLElement',
  'Element',
  'Node',
  'MouseEvent',
  'KeyboardEvent',
  'Event',
  'getComputedStyle',
  'localStorage'
]) {
  globalThis[key] =
    key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key];
}
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// JSDOM yerleşim hesaplamaz; odak tuzağının görünür öge denetimi için yeterlidir.
Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetParent', {
  get() {
    return this.isConnected && !this.hidden ? this.parentElement : null;
  }
});
const { createRoot } = await import('react-dom/client');

export function button(text, scope = document) {
  const found = [...scope.querySelectorAll('button')].find(
    (node) => node.textContent.trim() === text || node.getAttribute('aria-label') === text
  );
  assert.ok(found, `${text} düğmesi bulunmalıdır`);
  return found;
}

export function click(node) {
  assert.ok(node?.isConnected, 'Tıklanacak öge bağlı olmalıdır');
  if (node.disabled) return;
  // Her yerel olaydan sonra React işlenir: mousedown ile sökülen portalın
  // click işleyicisi çalışamaz. Asıl hata bu olay sırasına bağlıdır.
  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  act(() => node.dispatchEvent(down));
  if (!node.isConnected) return;
  if (!down.defaultPrevented) act(() => node.focus());
  act(() => node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true })));
  if (node.isConnected)
    act(() => node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
}

export function enter(input, value) {
  assert.ok(input, 'Giriş alanı bulunmalıdır');
  act(() => input.focus());
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
      input,
      value
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export function key(value, target = document.activeElement, options = {}) {
  const event = new KeyboardEvent('keydown', {
    key: value,
    bubbles: true,
    cancelable: true,
    ...options
  });
  act(() => target.dispatchEvent(event));
  return event;
}

export function mountDom(Component, props = {}, state = {}) {
  globalThis[CLIENT_STATE] = state;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (nextProps = props) =>
    act(() =>
      root.render(
        React.createElement(React.StrictMode, null, React.createElement(Component, nextProps))
      )
    );
  render();
  return {
    host,
    render,
    unmount() {
      act(() => root.unmount());
      host.remove();
      delete globalThis[CLIENT_STATE];
    }
  };
}

import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'next/dist/build/swc/index.js';
import React from 'react';

export const CLIENT_STATE = '__TASK_EDITOR_TEST_STATE__';
const stateModule = `data:text/javascript,${encodeURIComponent(`
export function useAppState() { return globalThis.${CLIENT_STATE}; }
export function useDataLifecycleState() { return {}; }
`)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/(^|\/)AppStateProvider(?:\.jsx)?$/.test(specifier)) return { url: stateModule, shortCircuit: true };
    if (specifier.startsWith('.') && extname(specifier) === '' && context.parentURL?.startsWith('file:')) {
      const base = resolve(dirname(fileURLToPath(context.parentURL)), specifier);
      const file = [`${base}.js`, `${base}.jsx`, resolve(base, 'index.js'), resolve(base, 'index.jsx')].find(existsSync);
      if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.endsWith('.jsx')) return nextLoad(url, context);
    const filename = fileURLToPath(url);
    const source = transformSync(readFileSync(filename, 'utf8'), {
      filename,
      jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'automatic' } }, target: 'es2022' },
      module: { type: 'es6' }
    }).code;
    return { format: 'module', source, shortCircuit: true };
  }
});

// Gerçek bileşenin kancaları ve olay işleyicileri, tarayıcı olmadan çalıştırılır.
export function mountComponent(Component, initialProps) {
  const slots = [];
  let props = initialProps;
  let position = 0;
  let dirty = true;
  let effects = [];
  let output;
  const frames = [];
  const sameDeps = (left, right) => left && right && left.length === right.length && left.every((value, i) => Object.is(value, right[i]));
  const memo = (factory, deps) => {
    const index = position++;
    if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: factory(), deps };
    return slots[index].value;
  };
  const dispatcher = {
    useState(initial) {
      const index = position++;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (next) => {
        const value = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; }
      }];
    },
    useRef(initial) { return memo(() => ({ current: initial }), []); },
    useMemo: memo,
    useCallback(callback, deps) { return memo(() => callback, deps); },
    useEffect(effect, deps) {
      const index = position++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) {
        const prior = slots[index];
        slots[index] = { deps, cleanup: prior?.cleanup };
        effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = effect(); });
      }
    },
    useContext(context) { return context._currentValue; },
    useId() { return memo(() => `test-id-${position}`, []); },
    useSyncExternalStore(_subscribe, snapshot, serverSnapshot) { return (serverSnapshot || snapshot)(); }
  };
  function render(nextProps = props) {
    props = nextProps;
    dirty = true;
    let count = 0;
    while (dirty) {
      if (++count > 30) throw new Error('Bileşen yeniden çizim döngüsü sonlanmadı.');
      dirty = false;
      position = 0;
      effects = [];
      const previous = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current;
      React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = dispatcher;
      try { output = Component(props); frames.push(output); }
      finally { React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = previous; }
      for (const effect of effects) effect();
    }
    return output;
  }
  render();
  return { render, frames, get output() { return output; }, unmount() { for (const slot of slots) slot?.cleanup?.(); } };
}

export function findElement(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (Array.isArray(tree)) {
    for (const child of tree) { const found = findElement(child, predicate); if (found) return found; }
    return null;
  }
  if (predicate(tree)) return tree;
  return findElement(tree.props?.children, predicate);
}

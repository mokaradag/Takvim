import { depId } from './dependencies/index.js';

const signature = (dep) => JSON.stringify([dep.type || 'FS', Number(dep.lagDays || 0), dep.lagValue ?? null, dep.lagUnit || null]);

/** Yalnızca kullanıcının gördüğü ilişkilerden açık ekleme/çıkarma niyeti üretir. */
export function dependencyChanges(observed = [], next = []) {
  const before = new Map(observed.map((dep) => [depId(dep), dep]));
  const after = new Map(next.map((dep) => [depId(dep), dep]));
  return {
    upserts: next.filter((dep) => !before.has(depId(dep)) || signature(before.get(depId(dep))) !== signature(dep)),
    removals: [...before.keys()].filter((id) => !after.has(id))
  };
}

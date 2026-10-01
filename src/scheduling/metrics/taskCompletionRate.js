export function taskCompletionRate(done, total) {
  return total ? Math.round((done / total) * 100) : 0;
}

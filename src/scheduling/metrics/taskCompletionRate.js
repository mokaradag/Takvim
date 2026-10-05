export function taskCompletionRate(done, total) {
  if (!total) return 0;
  const rate = Math.round((done / total) * 100);
  // %100 bütün görevlerin, %0 hiçbir görevin tamamlanmasıdır; yuvarlama bunu bozamaz.
  if (done < total && rate >= 100) return 99;
  if (done > 0 && rate <= 0) return 1;
  return rate;
}

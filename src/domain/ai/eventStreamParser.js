/**
 * Olay akışı (Server-Sent Events) satır ve olay çözücüsü — saf, sunucu ile
 * tarayıcının ortak kaynağı.
 *
 * WHATWG olay akışı kuralları: satır sonu `\r\n`, `\n` ya da `\r` olabilir; bir
 * parçanın sonundaki `\r` ile sonraki parçanın başındaki `\n` TEK satır
 * sonudur. `:` ile başlayan satır yorumdur (canlı tutma). `data` satırları
 * `\n` ile birleşir; olay yalnızca boş satırla yayımlanır.
 *
 * Ağ parçaları olay sınırlarına denk gelmez; satır sonu yalnızca YENİ gelen
 * metinde aranır (tamamlanmamış satır yeniden taranmaz). Tamamlanmamış satırın
 * ve tek olayın uzunluğu `maxEventChars` ile sınırlıdır; aşılırsa `tooLarge()`
 * ile üretilen hata fırlatılır.
 */
export function createEventStreamParser({ maxEventChars, tooLarge, onComment = null }) {
  let pending = '';
  let afterCr = false;
  let data = [];
  let dataChars = 0;
  let eventName = '';

  function dispatch(events) {
    if (data.length) events.push({ event: eventName || 'message', data: data.join('\n') });
    data = [];
    dataChars = 0;
    eventName = '';
  }

  function line(text, events) {
    if (text === '') {
      dispatch(events);
      return;
    }
    if (text.charCodeAt(0) === 58) {
      onComment?.(text.slice(1).trim());
      return;
    }
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? '' : text.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    if (field === 'data') {
      dataChars += value.length + (data.length ? 1 : 0);
      if (dataChars > maxEventChars) throw tooLarge();
      data.push(value);
    } else if (field === 'event') {
      eventName = value;
    }
  }

  return {
    /** Yeni metni işler; tamamlanan olayları `{ event, data }` olarak döndürür. */
    push(chunk) {
      const events = [];
      let position = 0;
      if (afterCr) {
        afterCr = false;
        if (chunk.charCodeAt(0) === 10) position = 1;
      }
      let nextLf = -2;
      let nextCr = -2;
      while (position < chunk.length) {
        if (nextLf !== -1 && nextLf < position) nextLf = chunk.indexOf('\n', position);
        if (nextCr !== -1 && nextCr < position) nextCr = chunk.indexOf('\r', position);
        if (nextLf < 0 && nextCr < 0) {
          pending += chunk.slice(position);
          if (pending.length > maxEventChars) throw tooLarge();
          return events;
        }
        const end = nextLf < 0 ? nextCr : nextCr < 0 ? nextLf : Math.min(nextLf, nextCr);
        const text = pending + chunk.slice(position, end);
        pending = '';
        if (text.length > maxEventChars) throw tooLarge();
        line(text, events);
        if (chunk.charCodeAt(end) === 13) {
          if (end + 1 >= chunk.length) afterCr = true;
          position = chunk.charCodeAt(end + 1) === 10 ? end + 2 : end + 1;
        } else {
          position = end + 1;
        }
      }
      return events;
    },

    /**
     * Akış sonu: satır sonu gelmemiş son satır işlenir. Boş satırla
     * yayımlanmamış olay YAYIMLANMAZ; yalnızca bekleyen verisi döner (yoksa `null`).
     */
    end() {
      if (pending) {
        const text = pending;
        pending = '';
        line(text, []);
      }
      const trailing = data.length ? data.join('\n') : null;
      data = [];
      dataChars = 0;
      eventName = '';
      return trailing;
    }
  };
}

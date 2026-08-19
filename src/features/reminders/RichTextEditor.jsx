'use client';
import { useEffect, useRef } from 'react';
import { Icons } from '../../components/icons';
import { sanitizeReminderHtml } from '../../domain/reminders/reminderTemplate.js';

/**
 * Küçük zengin metin düzenleyicisi.
 *
 * Yeni bir paket bağımlılığı eklenmez: tarayıcının `contentEditable` desteği ve
 * `document.execCommand` yeterlidir. Araç çubuğu, e-posta istemcilerinde
 * güvenilir çalışan biçimlendirmelerle sınırlıdır (kalın, italik, başlık,
 * madde/numaralı liste, bağlantı, tablo).
 *
 * GÜVENLİK: düzenleyicinin ürettiği HTML her değişiklikte alan modelindeki
 * temizleyiciden geçirilir ve sunucu da yazmadan önce aynı temizlemeyi
 * yeniden uygular. İstemci temizliği kolaylıktır, güvenlik sınırı değildir.
 */

const TOOLBAR = [
  { id: 'bold', label: 'Kalın', icon: 'B', command: 'bold' },
  { id: 'italic', label: 'İtalik', icon: 'I', command: 'italic' },
  { id: 'underline', label: 'Altı çizili', icon: 'U', command: 'underline' },
  { id: 'h2', label: 'Başlık', icon: 'H2', command: 'formatBlock', value: 'h2' },
  { id: 'h3', label: 'Alt başlık', icon: 'H3', command: 'formatBlock', value: 'h3' },
  { id: 'p', label: 'Paragraf', icon: '¶', command: 'formatBlock', value: 'p' },
  { id: 'ul', label: 'Madde listesi', icon: '•', command: 'insertUnorderedList' },
  { id: 'ol', label: 'Numaralı liste', icon: '1.', command: 'insertOrderedList' }
];

const TABLE_SNIPPET = [
  '<table style="border-collapse: collapse; width: 100%;">',
  '<tr><td style="padding: 7px 10px; border: 1px solid #e5e7eb;"><strong>Alan</strong></td>',
  '<td style="padding: 7px 10px; border: 1px solid #e5e7eb;">Değer</td></tr>',
  '</table>'
].join('');

export function RichTextEditor({ value, onChange, ariaLabel = 'E-posta gövdesi', disabled = false }) {
  const editorRef = useRef(null);
  const lastValueRef = useRef('');

  // Dışarıdan gelen değer YALNIZCA farklıysa yazılır: her tuş vuruşunda içerik
  // yeniden atansaydı imleç her seferinde başa atlardı.
  useEffect(() => {
    const element = editorRef.current;
    if (!element) return;
    if (value === lastValueRef.current) return;
    lastValueRef.current = value || '';
    element.innerHTML = value || '';
  }, [value]);

  const emit = () => {
    const element = editorRef.current;
    if (!element) return;
    const html = sanitizeReminderHtml(element.innerHTML);
    lastValueRef.current = html;
    onChange?.(html);
  };

  const run = (entry) => {
    if (disabled) return;
    editorRef.current?.focus();
    try {
      document.execCommand(entry.command, false, entry.value || null);
    } catch {
      // Komut desteklenmiyorsa metin olduğu gibi kalır; düzenleyici kilitlenmez.
    }
    emit();
  };

  const insertHtml = (html) => {
    if (disabled) return;
    editorRef.current?.focus();
    try {
      document.execCommand('insertHTML', false, html);
    } catch {
      // Yoksay: aşağıdaki `emit` mevcut içeriği korur.
    }
    emit();
  };

  const insertLink = () => {
    if (disabled) return;
    const href = prompt('Bağlantı adresi (https:// veya mailto:)');
    if (!href) return;
    if (!/^(https?:|mailto:)/i.test(href.trim())) {
      alert('Yalnızca https://, http:// ve mailto: adresleri eklenebilir.');
      return;
    }
    run({ command: 'createLink', value: href.trim() });
  };

  return (
    <div className={`rich-editor${disabled ? ' is-disabled' : ''}`}>
      <div className="rich-editor-toolbar" role="toolbar" aria-label="Biçimlendirme">
        {TOOLBAR.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="rich-editor-tool"
            title={entry.label}
            aria-label={entry.label}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => run(entry)}
          >
            {entry.icon}
          </button>
        ))}
        <button
          type="button"
          className="rich-editor-tool"
          title="Bağlantı ekle"
          aria-label="Bağlantı ekle"
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={insertLink}
        >
          <Icons.Link size={12} />
        </button>
        <button
          type="button"
          className="rich-editor-tool"
          title="Tablo ekle"
          aria-label="Tablo ekle"
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => insertHtml(TABLE_SNIPPET)}
        >
          <Icons.Table size={12} />
        </button>
      </div>
      <div
        ref={editorRef}
        className="rich-editor-surface"
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        onInput={emit}
        onBlur={emit}
        // Yapıştırılan içerik DÜZ METİN olarak alınır: dış kaynaktan gelen
        // biçimlendirme, e-posta istemcilerinde bozulan devasa bir HTML
        // yığınıyla birlikte gelir.
        onPaste={(event) => {
          event.preventDefault();
          const text = event.clipboardData?.getData('text/plain') || '';
          insertHtml(text.replace(/[<>]/g, (character) => (character === '<' ? '&lt;' : '&gt;')));
        }}
      />
    </div>
  );
}

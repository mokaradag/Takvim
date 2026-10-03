'use client';
import { useEffect, useId, useState } from 'react';
import { Icons } from '../../../components/icons';
import { ASSISTANT_MODES, assistantModeLabel, normalizeAssistantMessageText } from '../../../domain/ai/assistantContract.js';
import { composerKeyAction } from './assistantInteraction.js';
import { characterCountLabel } from './assistantPresentation.js';

/**
 * Yazma alanı: ileti kutusu ve aynı yüzeyde TEK satırlık araç çubuğu (yanıt
 * kaynağı, "Notlar ve iletiler", Derin düşünme, Gönder/Durdur). Çubuk sarmaz;
 * dar alanda etiketler önce kısalır, sonra simgeye iner, erişilebilir adlar
 * değişmez. Enter gönderir, Shift+Enter satır ekler; giriş yöntemi
 * birleştirmesi sürerken Enter gönderim sayılmaz. Yanıt sürerken taslak
 * yazılabilir ama gönderilemez (konuşmada tek üretim); gönder düğmesinin
 * yerini aynı boyuttaki Durdur alır. Boş ya da yalnızca boşluktan oluşan
 * ileti gönderilmez.
 */

const BUSY_HINT = 'Yanıt sürerken yeni ileti gönderilemez. Önce yanıtı durdurun ya da tamamlanmasını bekleyin.';

const SOURCE_OPTIONS = Object.freeze([
  { id: 'rota', label: 'Rota verisi', icon: Icons.Compass, title: 'Görüntüleme yetkiniz olan Rota verisinden, doğrulanmış kanıtla yanıtlar.' },
  { id: 'general', label: 'Genel sohbet', icon: Icons.Message, title: 'Rota verisi okunmaz; genel yardımcı olarak yanıtlar.' }
]);

export const INCLUDE_TEXT_HELP = 'Açıkken yalnızca bu ileti için, sorunuzun gerektirdiği kayıtlı açıklama, talep/karar iletisi ve değişiklik metinleri okunabilir. İleti gönderilince kendiliğinden kapanır.';
export const DEEP_MODE_HELP = 'Açıkken karmaşık sorular için daha kapsamlı düşünür; yanıt daha uzun sürebilir. Kapalıyken Standart kip günlük sorulara hızlı yanıt verir.';

/**
 * Seçeneklerden birini seçtiren düğme grubu (radyo grubu anlambilimi): ok
 * tuşları, Home ve End seçimi taşır; sekme sırasında grup tek duraktır.
 */
function SegmentedChoice({ label, value, options, onChange, disabled, className }) {
  const selectable = options.filter((item) => !item.disabled);
  const focusable = selectable.some((item) => item.id === value) ? value : selectable[0]?.id;
  const move = (event) => {
    if (!selectable.length) return;
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    let index = Math.max(0, selectable.findIndex((item) => item.id === value));
    if (event.key in keys) index = (index + keys[event.key] + selectable.length) % selectable.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = selectable.length - 1;
    else return;
    event.preventDefault();
    const next = selectable[index].id;
    onChange(next);
    const group = event.currentTarget?.closest?.('[role="radiogroup"]');
    (globalThis.requestAnimationFrame || setTimeout)(() => group?.querySelector(`[data-value="${next}"]`)?.focus());
  };
  return (
    <div className={`rota-assistant-seg ${className}`} role="radiogroup" aria-label={label}>
      {options.map(({ id, label: text, icon: Glyph, title, disabled: unavailable }) => (
        <button
          key={id}
          type="button"
          role="radio"
          data-value={id}
          aria-checked={id === value}
          tabIndex={id === focusable ? 0 : -1}
          className={id === value ? 'is-active' : ''}
          disabled={Boolean(disabled || unavailable)}
          title={title}
          onClick={() => onChange(id)}
          onKeyDown={move}
        >
          {Glyph && <Glyph size={14} aria-hidden="true" />}
          <span data-text={text}>{text}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Açılıp kapanan seçenek (anahtar anlambilimi). Tam etiket erişilebilir addır;
 * kısa etiket yalnızca dar alanda görünen süstür.
 */
function ToggleChip({ on, onToggle, icon: Glyph, label, shortLabel, help, helpId, disabled, className }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-describedby={helpId}
      className={`rota-assistant-toggle ${className}${on ? ' is-on' : ''}`}
      disabled={disabled}
      title={help}
      onClick={() => onToggle(!on)}
    >
      <Glyph size={14} aria-hidden="true" />
      <span className="rota-assistant-toggle-label" data-text={label}>{label}</span>
      <span className="rota-assistant-toggle-short" data-text={shortLabel} aria-hidden="true">{shortLabel}</span>
    </button>
  );
}

/** Standart varsayılan kiptir; Derin düşünme yalnızca iki kip de kullanılabilirken açılıp kapanır. */
function ModeToggle({ mode, modes, onChange, disabled, helpId }) {
  const available = (id) => modes.find((item) => item.id === id && item.available);
  const deep = available(ASSISTANT_MODES.DEEP);
  if (!deep || !available(ASSISTANT_MODES.STANDARD)) return null;
  return (
    <ToggleChip
      on={mode === ASSISTANT_MODES.DEEP}
      onToggle={(on) => onChange(on ? ASSISTANT_MODES.DEEP : ASSISTANT_MODES.STANDARD)}
      icon={Icons.Lightbulb}
      label={deep.label || assistantModeLabel(ASSISTANT_MODES.DEEP)}
      shortLabel="Derin"
      help={DEEP_MODE_HELP}
      helpId={helpId}
      disabled={disabled}
      className="is-deep"
    />
  );
}

export function AssistantComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  generating = false,
  disabled = false,
  submitDisabled = false,
  mode,
  modes = [],
  onModeChange,
  source = 'rota',
  dataEnabled = false,
  dataAvailable = true,
  dataUnavailableMessage = null,
  onSourceChange,
  includeText = false,
  onIncludeTextChange,
  maxChars,
  inputRef
}) {
  const inputId = useId();
  const hintId = useId();
  const counterId = useId();
  const textHelpId = useId();
  const modeHelpId = useId();
  const [storedHint, setHint] = useState(null);
  // "Yanıt sürerken gönderilemez" açıklaması yalnızca yanıt sürerken geçerlidir.
  const hint = storedHint === BUSY_HINT && !generating ? null : storedHint;
  useEffect(() => {
    if (!generating) setHint((current) => (current === BUSY_HINT ? null : current));
  }, [generating]);
  const normalizedValue = normalizeAssistantMessageText(value);
  const normalizedLength = normalizedValue.length;
  const overLimit = normalizedLength > maxChars;
  const blank = !normalizedValue;
  const canSubmit = !disabled && !submitDisabled && !generating && !blank && !overLimit;
  const counter = characterCountLabel(normalizedLength, maxChars);

  // Alan içeriğe göre büyür; üst sınır CSS'tedir (sonrası kendi içinde kayar).
  useEffect(() => {
    const node = inputRef?.current;
    if (!node?.style) return;
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  }, [value, inputRef]);

  const submit = () => {
    if (generating) {
      setHint(BUSY_HINT);
      return;
    }
    if (!canSubmit) return;
    const result = onSubmit(value);
    setHint(result?.ok === false && result.message ? result.message : null);
  };

  // Kutunun boş alanına tıklamak yazma alanına odaklar; denetimler kendi işini yapar.
  const focusFromBox = (event) => {
    if (event.target !== event.currentTarget && !event.target?.classList?.contains?.('rota-assistant-toolbar')) return;
    event.preventDefault();
    inputRef?.current?.focus?.();
  };

  const onKeyDown = (event) => {
    const action = composerKeyAction({
      key: event.key,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      keyCode: event.keyCode,
      isComposing: event.nativeEvent?.isComposing
    }, { canSubmit: !generating && !disabled && !submitDisabled });
    if (action === 'send') {
      event.preventDefault();
      submit();
    } else if (action === 'blocked') {
      event.preventDefault();
      if (generating) setHint(BUSY_HINT);
    }
  };

  return (
    <form
      className="rota-assistant-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className={`rota-assistant-composer-box${disabled ? ' is-disabled' : ''}`} onPointerDown={focusFromBox}>
        <label className="sr-only" htmlFor={inputId}>Bilgin’e iletiniz</label>
        <textarea
          id={inputId}
          ref={inputRef}
          className="rota-assistant-input"
          rows={1}
          value={value}
          placeholder="Bilgin’e sorun…"
          disabled={disabled}
          aria-invalid={overLimit || undefined}
          aria-describedby={`${hintId} ${counterId}`}
          enterKeyHint="send"
          onChange={(event) => {
            onChange(event.target.value);
            if (hint) setHint(null);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="rota-assistant-toolbar">
          {dataEnabled && (
            <SegmentedChoice
              label="Yanıt kaynağı"
              className="rota-assistant-source"
              value={source}
              options={SOURCE_OPTIONS.map((item) => (item.id === 'rota' ? { ...item, disabled: !dataAvailable } : item))}
              onChange={(next) => { if (next !== source) onSourceChange?.(next); }}
              disabled={disabled || generating}
            />
          )}
          {dataEnabled && source === 'rota' && (
            <ToggleChip
              on={includeText}
              onToggle={(next) => onIncludeTextChange?.(next)}
              icon={Icons.Notes}
              label="Notlar ve iletiler"
              shortLabel="Notlar"
              help={INCLUDE_TEXT_HELP}
              helpId={textHelpId}
              disabled={disabled || generating}
              className="is-text"
            />
          )}
          <span id={counterId} className="rota-assistant-composer-counter">
            {counter && !overLimit ? counter : <span className="sr-only">Enter gönderir, Shift+Enter yeni satır ekler.</span>}
          </span>
          <ModeToggle mode={mode} modes={modes} onChange={onModeChange} disabled={disabled} helpId={modeHelpId} />
          {/* Gönder ile Durdur aynı boyutta ve aynı sabit yuvada yer değiştirir; öteki denetimler kaymaz. */}
          <span className="rota-assistant-composer-action">
            {generating ? (
              <button type="button" className="rota-assistant-stop" title="Yanıtı durdur" onClick={onStop}>
                <Icons.Stop size={14} aria-hidden="true" />
                <span className="sr-only">Durdur</span>
              </button>
            ) : (
              <button type="submit" className="rota-assistant-send" disabled={!canSubmit} aria-label="Gönder" title="Gönder (Enter)">
                <Icons.ArrowUp size={16} aria-hidden="true" />
              </button>
            )}
          </span>
        </div>
      </div>
      <span id={textHelpId} className="sr-only">{INCLUDE_TEXT_HELP}</span>
      <span id={modeHelpId} className="sr-only">{DEEP_MODE_HELP}</span>
      <p id={hintId} className={`rota-assistant-composer-hint${hint || overLimit ? ' is-warn' : ''}`} aria-live="polite">
        {hint || (overLimit ? `İleti en fazla ${maxChars.toLocaleString('tr-TR')} karakter olabilir.` : '')}
      </p>
      {dataEnabled && dataUnavailableMessage && <p className="rota-assistant-composer-note" role="status">{dataUnavailableMessage}</p>}
    </form>
  );
}

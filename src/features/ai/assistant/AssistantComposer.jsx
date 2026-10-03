'use client';
import { useEffect, useId, useState } from 'react';
import { Icons } from '../../../components/icons';
import { normalizeAssistantMessageText } from '../../../domain/ai/assistantContract.js';
import { composerKeyAction } from './assistantInteraction.js';
import { characterCountLabel } from './assistantPresentation.js';

/**
 * Yazma alanı. Enter gönderir, Shift+Enter satır ekler; giriş yöntemi
 * birleştirmesi sürerken Enter gönderim sayılmaz. Yanıt sürerken taslak
 * yazılabilir ama gönderilemez (konuşmada tek üretim); gönder düğmesinin
 * yerini Durdur alır. Boş ya da yalnızca boşluktan oluşan ileti gönderilmez.
 */

const BUSY_HINT = 'Yanıt sürerken yeni ileti gönderilemez. Önce yanıtı durdurun ya da tamamlanmasını bekleyin.';

function ModeSwitch({ mode, modes, onChange, disabled }) {
  const selectable = modes.filter((item) => item.available);
  if (selectable.length < 2) return null;
  const move = (event) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    let index = selectable.findIndex((item) => item.id === mode);
    if (event.key in keys) index = (index + keys[event.key] + selectable.length) % selectable.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = selectable.length - 1;
    else return;
    event.preventDefault();
    onChange(selectable[index].id);
    const group = event.currentTarget?.closest?.('[role="radiogroup"]');
    const next = selectable[index].id;
    (globalThis.requestAnimationFrame || setTimeout)(() => group?.querySelector(`[data-mode="${next}"]`)?.focus());
  };
  return (
    <div className="rota-assistant-modes seg" role="radiogroup" aria-label="Yanıt kipi">
      {selectable.map((item) => (
        <button
          key={item.id}
          type="button"
          role="radio"
          data-mode={item.id}
          aria-checked={item.id === mode}
          tabIndex={item.id === mode ? 0 : -1}
          className={item.id === mode ? 'active' : ''}
          disabled={disabled}
          title={item.id === 'deep' ? 'Karmaşık sorular için daha kapsamlı düşünür; yanıt daha uzun sürebilir.' : 'Günlük sorular için hızlı yanıt.'}
          onClick={() => onChange(item.id)}
          onKeyDown={move}
        >
          {item.label}
        </button>
      ))}
    </div>
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
      <label className="sr-only" htmlFor={inputId}>Rota AI’ye iletiniz</label>
      <textarea
        id={inputId}
        ref={inputRef}
        className="rota-assistant-input"
        rows={1}
        value={value}
        placeholder="Rota AI’ye sorun…"
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
      <div className="rota-assistant-composer-bar">
        {dataEnabled && <label>
          Yanıt kaynağı
          <select aria-label="Yanıt kaynağı" value={source} disabled={disabled || generating} onChange={(event) => onSourceChange?.(event.target.value)}>
            <option value="rota" disabled={!dataAvailable}>Rota verisi · doğrulanmış kanıt</option>
            <option value="general">Genel sohbet · Rota verisi okunmaz</option>
          </select>
          {dataUnavailableMessage && <span role="status">{dataUnavailableMessage}</span>}
        </label>}
        {dataEnabled && source === 'rota' && <label>
          <input type="checkbox" checked={includeText} disabled={disabled || generating} onChange={(event) => onIncludeTextChange?.(event.target.checked)} />
          Notları ve iletileri dahil et
        </label>}
        <ModeSwitch mode={mode} modes={modes} onChange={onModeChange} disabled={disabled} />
        <span className="rota-assistant-composer-status">
          <span id={hintId} className={`rota-assistant-composer-hint${hint || overLimit ? ' is-warn' : ''}`} aria-live="polite">
            {hint || (overLimit ? `İleti en fazla ${maxChars.toLocaleString('tr-TR')} karakter olabilir.` : '')}
          </span>
          <span id={counterId} className="rota-assistant-composer-counter">
            {counter && !overLimit ? counter : <span className="sr-only">Enter gönderir, Shift+Enter yeni satır ekler.</span>}
          </span>
        </span>
        {generating ? (
          <button type="button" className="rota-assistant-stop" onClick={onStop}>
            <Icons.Stop size={13} aria-hidden="true" /> Durdur
          </button>
        ) : (
          <button type="submit" className="rota-assistant-send" disabled={!canSubmit} aria-label="Gönder" title="Gönder (Enter)">
            <Icons.ArrowUp size={15} aria-hidden="true" />
          </button>
        )}
      </div>
    </form>
  );
}

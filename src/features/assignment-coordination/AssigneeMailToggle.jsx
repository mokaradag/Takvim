'use client';
import { Icons } from '../../components/icons.jsx';

/**
 * "Sorumlulara e-posta bildirimi gönder" kutusu.
 *
 * Varsayılan KAPALIDIR ve kalıcı bir kullanıcı tercihi olarak SAKLANMAZ:
 * kullanıcı her kayıt işleminde ayrıca seçer, böylece olağan kayıtlar posta
 * üretmez.
 *
 * Seçim yalnızca bir NİYET üretir; teslimat dayanıklı kuyruktan arka planda
 * yapılır ve görev kaydı SMTP'yi beklemez.
 */
export function AssigneeMailToggle({ checked, onChange, disabled = false }) {
  return (
    <label className="assignee-mail-toggle" title="Bildirim, kayıt tamamlandıktan sonra arka planda gönderilir.">
      <input type="checkbox" checked={Boolean(checked)} disabled={disabled}
        onChange={(event) => onChange?.(event.target.checked)} />
      <Icons.Mail size={13} aria-hidden="true" />
      <span>Sorumlulara e-posta bildirimi gönder</span>
    </label>
  );
}

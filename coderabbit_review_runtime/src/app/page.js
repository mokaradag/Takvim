'use client';
import dynamic from 'next/dynamic';
import { setAppDateDisplayFormat } from '../scheduling/dates';

// Uygulama tercihleri yüklenene kadar geçerli olan başlangıç değeri. Kullanıcı
// seçimi Ayarlar > Tarih biçimi üzerinden gelir (bkz. hooks/useApplyTweaks.js).
setAppDateDisplayFormat('dd/mm/yyyy');

const App = dynamic(() => import('../components/shell/ApplicationRoot'), { ssr: false });

export default function Page() {
  return <App />;
}

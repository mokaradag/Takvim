'use client';
import dynamic from 'next/dynamic';

const App = dynamic(() => import('../components/shell/ApplicationRoot'), { ssr: false });

export default function Page() {
  return <App />;
}

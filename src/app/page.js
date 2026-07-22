'use client';
import dynamic from 'next/dynamic';
import { setAppDateDisplayFormat } from '../scheduling/dates';

setAppDateDisplayFormat('dd/mm/yyyy');

const App = dynamic(() => import('../components/shell/ApplicationRoot'), { ssr: false });

export default function Page() {
  return <App />;
}

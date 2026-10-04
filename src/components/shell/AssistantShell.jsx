'use client';
import '../../app/styles/assistant.css';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { RotaAssistantLauncher, RotaAssistantPanel, useRotaAssistant } from '../../features/ai/assistant/RotaAssistant.jsx';

export default function AssistantShell({ onChange, onOpenSettings }) {
  const assistant = useRotaAssistant();
  useEffect(() => {
    onChange({ enabled: assistant.enabled, openPanel: assistant.openPanel });
    return () => onChange({ enabled: false });
  }, [onChange, assistant.enabled, assistant.openPanel]);
  return <>
    <RotaAssistantLauncher assistant={assistant} />
    {createPortal(<RotaAssistantPanel assistant={assistant} onOpenSettings={onOpenSettings} />, document.body)}
  </>;
}

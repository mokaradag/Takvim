'use client';
import '../../app/styles/assistant.css';
import { useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { RotaAssistantLauncher, RotaAssistantPanel, useRotaAssistant } from '../../features/ai/assistant/RotaAssistant.jsx';
import { EvidenceCardActionsContext } from '../../features/ai/assistant/EvidenceCard.jsx';
import { useTaskActions } from '../../state/hooks';

export default function AssistantShell({ onChange, onOpenSettings, answerDetail = null }) {
  const assistant = useRotaAssistant();
  // Kanıt kartındaki görev, mevcut görev açma sözleşmesiyle (kimlikle) açılır; olağan erişim kuralları orada uygulanır.
  const { openTask } = useTaskActions();
  const cardActions = useMemo(() => ({ openTask: (taskId) => { openTask(taskId); } }), [openTask]);
  // Ayarlar'daki yanıt ayrıntısı denetleyiciye bildirilir (tercih kabuğun görünüm tercihlerindedir).
  useEffect(() => { assistant.controller.setAnswerDetail(answerDetail); }, [assistant.controller, answerDetail]);
  useEffect(() => {
    onChange({ enabled: assistant.enabled, openPanel: assistant.openPanel });
    return () => onChange({ enabled: false });
  }, [onChange, assistant.enabled, assistant.openPanel]);
  return <>
    <RotaAssistantLauncher assistant={assistant} />
    {createPortal(
      <EvidenceCardActionsContext.Provider value={cardActions}>
        <RotaAssistantPanel assistant={assistant} onOpenSettings={onOpenSettings} />
      </EvidenceCardActionsContext.Provider>,
      document.body
    )}
  </>;
}

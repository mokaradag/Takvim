// Bu işaretler yalnızca ihtiyatlı yönlendirmedir; olgu doğrulaması değildir.
const ROTA_CONTEXT = /rota|görev|proje|portföy|iş yük|sorumlu|termin|planlanan|gerçekleşen|bildirim|atama|baz plan|bağımlılık|takvim|outlook|wbs|task|project|portfolio|workload|assignee|deadline|baseline|notification|dependency|recurren|calendar|status/iu;

export function requiresRotaEvidence(text, { priorGrounded = false, dataIntent = false } = {}) {
  return priorGrounded || dataIntent || ROTA_CONTEXT.test(String(text ?? ''));
}

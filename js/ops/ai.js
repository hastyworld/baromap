// 운영 AI 단추(선택, 회사 보안 승인 전에는 숨김). ai_settings.enabled가 꺼져 있으면 단추를 그리지 않고, 꺼져 있어도 모든 기능이 AI 없이 돈다(09 6절).
import { store } from '../ctx.js';
import { icon } from '../util.js';

export const aiOn = () => Boolean(store.ai?.available);

export const aiDailyDraftButton = () => (aiOn() ? `<button type="button" class="btn" data-act="dy-ai-draft">${icon('edit')}AI 초안</button>` : '');

'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, Send, UsersRound, UserRoundPlus } from 'lucide-react';
import { api } from '@/lib/client-api';
import { activeMembers, money, plural, type InvitationPreview, type Member, type Trip } from '@/lib/model';
import type {} from '@/lib/telegram-app';

type SelectionResult = { status: 'pending' | 'completed' | 'expired'; memberIds?: string[]; addedCount?: number; skippedCount?: number };
type Props = { trip: Trip; selectedMemberIds: string[] | null; onDone: () => void; onRefresh: () => Promise<Trip[]>; fallback: ReactNode };

export function ParticipantInvites({ trip, selectedMemberIds, onDone, onRefresh, fallback }: Props) {
  const [readyIds, setReadyIds] = useState<string[] | null>(null);
  const [requestId, setRequestId] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [link, setLink] = useState('');
  const [methods, setMethods] = useState(false);
  const refreshRef = useRef(onRefresh);
  useEffect(() => { refreshRef.current = onRefresh; }, [onRefresh]);
  useEffect(() => {
    if (selectedMemberIds) { setReadyIds(selectedMemberIds); setError(''); setMessage(''); setLink(''); setMethods(false); }
  }, [selectedMemberIds]);
  useEffect(() => {
    if (requestId === null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    async function poll() {
      try {
        const result: SelectionResult = await api('participantSelection', { eventId: trip.id, requestId }, controller.signal);
        if (controller.signal.aborted) return;
        if (result.status === 'completed') {
          await refreshRef.current();
          if (controller.signal.aborted) return;
          const ids = result.memberIds || [];
          setReadyIds(ids.length ? ids : null); setRequestId(null); setError('');
          setMessage(ids.length ? '' : 'Все выбранные люди уже участвуют либо были удалены. Для возврата удалённого участника отправьте новую ссылку.');
          if (result.skippedCount && ids.length) setMessage(`Пропущено: ${result.skippedCount}. Эти люди уже участвуют либо были удалены.`);
          return;
        }
        if (result.status === 'expired') { setRequestId(null); setError('Время выбора истекло. Выберите участников ещё раз.'); return; }
        if (++attempts >= 30) { setError('Telegram ещё не передал выбранных людей. Можно проверить результат ещё раз.'); return; }
        timer = setTimeout(poll, 1000);
      } catch (cause) {
        if (!controller.signal.aborted) setError((cause as Error).message);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [requestId, retry, trip.id]);

  const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : undefined;
  const supportsSelection = !!tg?.requestChat && !!tg.isVersionAtLeast?.('9.6');
  const ready = readyIds ? activeMembers(trip).filter(member => readyIds.includes(member.id) && member.status === 'invited') : [];
  function done() { setReadyIds(null); setMethods(false); setLink(''); setError(''); onDone(); }
  async function selectPeople() {
    if (!supportsSelection || !tg?.requestChat) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api('selectParticipants', { eventId: trip.id });
      tg.requestChat(result.preparedId, sent => {
        if (sent) { setRequestId(result.requestId); setMessage('Получаем выбранных людей из Telegram…'); }
        else setMessage('Выбор отменён. Можно пригласить людей позже.');
      });
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  async function share(delivery: 'personal' | 'group' | 'any') {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api('shareParticipantInvite', { eventId: trip.id, memberIds: ready.map(member => member.id), delivery });
      setLink(result.url);
      if (result.mode === 'sent') { done(); setMessage('Приглашение отправлено от бота'); }
      else if (tg?.shareMessage && tg.isVersionAtLeast?.('8.0')) {
        tg.shareMessage(result.preparedId, sent => setMessage(sent ? 'Приглашение отправлено' : 'Отправка отменена. Участники сохранены в расчётах.'));
      } else setMessage('Скопируйте ссылку и отправьте её в Telegram.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  async function copyLink() {
    try { await navigator.clipboard.writeText(link); setMessage('Ссылка скопирована'); }
    catch { setMessage('Выделите и скопируйте ссылку из поля ниже.'); }
  }
  async function getLink() {
    setBusy(true); setError('');
    try { const result = await api('invite', { eventId: trip.id }); setLink(result.url); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="participant-invites">
    {readyIds && ready.length > 0 ? <div className="invitation-ready">
      <div className="invitation-ready-title"><Check size={20} /><h3>{ready.length === 1 ? 'Участник добавлен в расчёты' : `${ready.length} ${plural(ready.length, ['участник добавлен', 'участника добавлены', 'участников добавлены'])}`}</h3></div>
      <p className="help-note">{ready.map(member => member.name).join(', ')}. Уже можно распределять расходы. Для доступа к мероприятию отправьте приглашение.</p>
      <button type="button" className="primary-button" disabled={busy} onClick={() => { void share(ready.length === 1 ? 'personal' : 'group'); }}><Send size={18} />{busy ? 'Готовим приглашение…' : ready.length === 1 ? 'Отправить приглашение' : 'Отправить в общий чат'}</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => setMethods(value => !value)}>Другой способ</button>
      {methods && <><button type="button" className="secondary-button" disabled={busy} onClick={() => { void share('any'); }}>Поделиться через Telegram</button><button type="button" className="secondary-button" disabled={busy} onClick={() => { void getLink(); }}>Получить ссылку</button></>}
      <button type="button" className="invitation-later" disabled={busy} onClick={done}>Позже</button>
    </div> : <>
      <button type="button" className="primary-button" disabled={busy || requestId !== null || !supportsSelection} onClick={() => { void selectPeople(); }}><UserRoundPlus size={18} />{busy ? 'Открываем Telegram…' : requestId !== null ? 'Получаем участников…' : 'Добавить участников'}</button>
      <p className="help-note">{supportsSelection ? 'Откроется окно Telegram. Выберите до 10 человек — они сразу появятся в расчётах.' : 'Для выбора людей обновите Telegram. Пока можно пригласить участников по ссылке.'}</p>
      {fallback}
    </>}
    {requestId !== null && error && <><button type="button" className="secondary-button" onClick={() => { setError(''); setRetry(value => value + 1); }}>Проверить результат</button><button type="button" className="secondary-button" onClick={() => { setRequestId(null); setError(''); setMessage(''); }}>Выбрать заново</button></>}
    {link && <div className="invitation-link-fallback"><label className="field-label" htmlFor="participant-invite-url">Ссылка приглашения</label><textarea id="participant-invite-url" className="text-input invite-link-input" readOnly value={link} rows={3} onFocus={event => event.currentTarget.select()} /><button type="button" className="secondary-button" onClick={() => { void copyLink(); }}><Copy size={18} />Скопировать ссылку</button></div>}
    {message && <p className="help-note" role="status">{message}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}

export function InvitationPanel({ preview, currentMember, onAccept, onClose }: { preview: InvitationPreview; currentMember: Member; onAccept: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function accept() {
    setBusy(true); setError('');
    try { await onAccept(); } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="sheet-body invitation-preview">
    <div className="invitation-event-icon"><UsersRound size={30} /></div>
    <h3>{preview.name}</h3><p className="form-intro">{preview.ownerName} приглашает вас делить общие расходы.</p>
    <p className="help-note">В мероприятии {preview.memberCount} {plural(preview.memberCount, ['участник', 'участника', 'участников'])}.</p>
    {preview.personalShare > 0 && <div className="invitation-share"><span>На вас уже учтено</span><strong>{money(preview.personalShare)}</strong><p>Эти расходы будут доступны после присоединения.</p></div>}
    <p className="help-note">Вы входите как <strong>{currentMember.name}</strong>{currentMember.username ? ` (${currentMember.username})` : ''}.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button type="button" className="primary-button" disabled={busy} onClick={() => { void accept(); }}>{busy ? 'Присоединяем…' : preview.joined ? 'Открыть мероприятие' : 'Присоединиться'}</button>
    <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Позже</button>
  </div>;
}

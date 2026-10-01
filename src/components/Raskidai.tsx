'use client';

import { useEffect, useRef, useState } from 'react';
import Script from 'next/script';
import { ArrowDownLeft, ArrowUpRight, ArrowLeft, ArrowRight, ArrowLeftRight, Plus, ChevronRight, Ellipsis, Check, X, Wallet, UserRound, Sparkles, Clock3, House, Car, Utensils, Ticket, Shapes, UsersRound, Moon, Sun, Archive, CheckCheck, Pencil, Trash2, Info, CalendarDays, Send, RotateCcw, Copy } from 'lucide-react';
import { ME, STORAGE_KEY, balances, categories, confirmPendingSettlement, distribute, members, money, parseMoney, personalSummary, plural, seedTrips, today, transfers, uid, type Category, type Expense, type Member, type Settlement, type SplitMode, type Trip } from '@/lib/model';

type Tab = 'trips' | 'activity' | 'profile';
type TripTab = 'expenses' | 'balances' | 'summary';
type Move = { from: string; to: string; amount: number };
function canMarkSettlement(move: Move) { return move.from === ME || move.to === ME; }
type Modal = { type: 'create' } | { type: 'expense'; expense?: Expense } | { type: 'settlement'; move: Move } | { type: 'demo-confirm'; settlementId: string } | { type: 'members' } | { type: 'details'; expense: Expense } | { type: 'menu' } | { type: 'archive' } | { type: 'reset' } | null;
type TelegramUser = { first_name?: string; last_name?: string; username?: string };
type TelegramApp = { initData: string; ready: () => void; expand: () => void; close: () => void; colorScheme: string; isFullscreen?: boolean; requestFullscreen?: () => void; setHeaderColor?: (color: string) => void; setBackgroundColor?: (color: string) => void; BackButton: { show: () => void; hide: () => void; onClick: (fn: () => void) => void; offClick: (fn: () => void) => void }; HapticFeedback?: { impactOccurred: (style: string) => void; notificationOccurred: (style: string) => void }; onEvent: (name: string, fn: () => void) => void; offEvent: (name: string, fn: () => void) => void };
declare global { interface Window { Telegram?: { WebApp?: TelegramApp } } }

const categoryIcons = { home: House, transport: Car, food: Utensils, fun: Ticket, other: Shapes };
const tripSymbols: Record<string, string> = { default: '📅', mountains: '⛰️', sea: '🏖️', city: '🏙️', dinner: '🍽️', celebration: '🎉' };
const tripSymbolChoices = [
  { id: 'default', label: 'Календарь' },
  { id: 'mountains', label: 'Горы' },
  { id: 'sea', label: 'Море' },
  { id: 'city', label: 'Город' },
  { id: 'dinner', label: 'Ужин' },
  { id: 'celebration', label: 'Праздник' },
] as const;
function TripSymbol({ cover }: { cover: string }) { return <span className="trip-symbol" aria-hidden="true">{tripSymbols[cover] || '📅'}</span>; }
const splitNames: Record<SplitMode, string> = { equal: 'Поровну', percent: 'Проценты', shares: 'Проценты', exact: 'Суммы' };
const availableSplitModes: SplitMode[] = ['equal', 'percent', 'exact'];
async function api(action: string, values: Record<string, unknown> = {}) {
  const response = await fetch('/api/app', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...values }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Не удалось выполнить действие');
  return result;
}
function Avatar({ member, small = false }: { member: Member; small?: boolean }) { return <span className={`avatar ${small ? 'small' : ''}`} style={{ background: member.color }}>{small ? Array.from(member.initials)[0] : member.initials}</span>; }
function Avatars({ people }: { people: Member[] }) { return <div className="avatar-stack">{people.slice(0, 4).map(person => <Avatar key={person.id} member={person} small />)}<span>{people.length} {plural(people.length, ['участник', 'участника', 'участников'])}</span></div>; }
function CategoryIcon({ category }: { category: Category }) { const Icon = categoryIcons[category]; const color = categories.find(c => c.id === category)!.color; return <span className="category-icon" style={{ color, background: `${color}18` }}><Icon size={21} strokeWidth={1.8} /></span>; }
function DisplayMemberName({ member }: { member: Member }) { return <>{member.name}{member.id === ME && <small className="self-label"> (Вы)</small>}</>; }
function MemberName({ id, trip }: { id: string; trip: Trip }) {
  const member = trip.members.find(item => item.id === id) || members.find(item => item.id === id);
  return member ? <DisplayMemberName member={member} /> : null;
}
function displayHistory(entry: string, trip: Trip) {
  const currentName = trip.members.find(member => member.id === ME)?.name;
  return currentName && !entry.includes(`${currentName} (Вы)`) ? entry.replaceAll(currentName, `${currentName} (Вы)`) : entry;
}
function dateLabel(value: string) { return new Date(`${value}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }); }
function hasTelegramLaunchParams() { return /tgWebApp/i.test(location.search + location.hash); }
function refreshDemoNames(trip: Trip): Trip {
  const fullHistoryName = (entry: string) => {
    for (const member of members) {
      const firstName = member.name.split(' ')[0];
      if (entry === `Расход добавлен: ${firstName}`) return `Расход добавлен: ${member.name}`;
      if (entry === `${firstName} добавил расход`) return `Расход добавлен пользователем: ${member.name}`;
      if (entry === `${firstName} изменил расход`) return `Расход изменён пользователем: ${member.name}`;
    }
    return entry;
  };
  return {
    ...trip,
    members: trip.members.map(member => { const demo = members.find(item => item.id === member.id); return demo ? { ...member, name: demo.name, initials: demo.initials, username: demo.username } : member; }),
    expenses: trip.expenses.map(expense => ({ ...expense, history: expense.history.map(fullHistoryName) })),
  };
}
function telegramMember(user: TelegramUser): Member | null {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  if (!name) return null;
  const initials = [user.first_name, user.last_name].filter(Boolean).map(part => Array.from(part!)[0]).join('').toLocaleUpperCase('ru-RU');
  return { ...members[0], name, initials, username: user.username ? `@${user.username}` : '' };
}
function withCurrentMember(trip: Trip, currentMember: Member): Trip {
  return {
    ...trip,
    members: trip.members.map(member => member.id === ME ? { ...member, ...currentMember } : member),
    expenses: trip.expenses.map(expense => ({ ...expense, history: expense.history.map(entry => entry.replaceAll(members[0].name, currentMember.name)) })),
  };
}

function TransferCard({ trip, move, pending, onSettle, onConfirm, onDemoConfirm }: { trip: Trip; move: Move; pending?: Settlement; onSettle?: () => void; onConfirm?: () => void; onDemoConfirm?: () => void }) {
  const direction = move.from === ME ? 'outgoing' : move.to === ME ? 'incoming' : 'other';
  return <div className={`transfer-card ${direction}${pending ? ' pending' : ''}`}>
    <div className="transfer-route"><div className="transfer-party"><Avatar member={trip.members.find(m => m.id === move.from)!} small /><strong><MemberName id={move.from} trip={trip} /></strong></div><ArrowRight size={16} /><div className="transfer-party"><Avatar member={trip.members.find(m => m.id === move.to)!} small /><strong><MemberName id={move.to} trip={trip} /></strong></div></div>
    {pending && <div className="transfer-pending-state"><Clock3 size={14} />Ожидает подтверждения</div>}
    <div className="transfer-bottom"><strong>{money(move.amount)}</strong>{pending ? direction === 'incoming' && <button onClick={onConfirm}><Check size={16} />Я получил</button> : direction !== 'other' && <button onClick={onSettle}><Check size={16} />{direction === 'outgoing' ? 'Я перевел' : 'Я получил'}</button>}</div>
    {pending && onDemoConfirm && <button className="demo-confirm-link" onClick={onDemoConfirm}>Демо: подтвердить за получателя</button>}
  </div>;
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className="sheet" aria-label={title} onCancel={event => { event.preventDefault(); closeRef.current(); }} onClick={event => { if (event.target === event.currentTarget) closeRef.current(); }}>
    <div className="sheet-inner"><header className="sheet-header"><h2>{title}</h2><button type="button" className="icon-button close-button" onClick={onClose} aria-label="Закрыть окно"><X size={19} /></button></header><div className="sheet-scroll">{children}</div></div>
  </dialog>;
}

function InviteLink({ eventId }: { eventId: string }) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const linkRef = useRef<HTMLTextAreaElement>(null);

  async function createInvite() {
    setLoading(true); setError('');
    try {
      const result = await api('invite', { eventId });
      if (typeof result.url !== 'string' || !result.url) throw new Error('Не удалось получить ссылку приглашения');
      setUrl(result.url);
    } catch (err) { setError(err instanceof Error ? err.message : 'Не удалось создать приглашение. Попробуйте ещё раз.'); }
    finally { setLoading(false); }
  }

  async function copyInvite() {
    setCopying(true); setMessage('');
    try { await navigator.clipboard.writeText(url); setMessage('Ссылка скопирована'); }
    catch {
      linkRef.current?.focus(); linkRef.current?.select();
      setMessage('Не удалось скопировать автоматически. Ссылка выделена — скопируйте её вручную.');
    } finally { setCopying(false); }
  }

  return <div className="invite-link-panel">
    {url ? <>
      <label className="field-label" htmlFor="event-invite-link">Ссылка приглашения</label>
      <textarea ref={linkRef} id="event-invite-link" className="text-input invite-link-input" rows={3} readOnly value={url} onFocus={event => event.currentTarget.select()} />
      <button type="button" className="primary-button" disabled={copying} onClick={() => { void copyInvite(); }}><Copy size={18} />{copying ? 'Копируем…' : 'Скопировать ссылку'}</button>
      {message && <p className="help-note" role="status">{message}</p>}
    </> : <button type="button" className="primary-button" disabled={loading} onClick={() => { void createInvite(); }}><Send size={18} />{loading ? 'Создаём ссылку…' : 'Пригласить по ссылке'}</button>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <p className="help-note">Отправьте ссылку участнику: он откроет её под своим Telegram-аккаунтом.</p>
  </div>;
}

export default function Raskidai() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [mode, setMode] = useState<'loading' | 'demo' | 'live' | 'error'>('loading');
  const [telegramReady, setTelegramReady] = useState(false);
  const live = mode === 'live';
  const [authError, setAuthError] = useState('');
  const [currentMember, setCurrentMember] = useState<Member>(members[0]);
  const [storageError, setStorageError] = useState(false);
  const [tab, setTab] = useState<Tab>('trips');
  const [tripId, setTripId] = useState<string | null>(null);
  const [tripTab, setTripTab] = useState<TripTab>('expenses');
  const [modal, setModal] = useState<Modal>(null);
  const [archived, setArchived] = useState(false);
  const [dark, setDark] = useState(false);
  const [toast, setToast] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const launchAttempt = useRef(false);
  const trip = trips.find(t => t.id === tripId);
  function notify(message: string) { setToast(message); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setToast(''), 3000); if (window.Telegram?.WebApp?.initData) window.Telegram.WebApp.HapticFeedback?.notificationOccurred('success'); }
  function enterDemo() {
    try { const saved = localStorage.getItem(STORAGE_KEY); const data = saved ? JSON.parse(saved) : null; setTrips(data?.version === 1 && Array.isArray(data.trips) ? (data.trips as Trip[]).map(refreshDemoNames) : seedTrips()); }
    catch { setStorageError(true); setTrips(seedTrips()); }
    setAuthError(''); setMode('demo');
  }
  useEffect(() => {
    try { setDark(localStorage.getItem('raskidai:theme') === 'dark'); } catch { setStorageError(true); }
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, []);
  useEffect(() => { if (mode !== 'demo') return; try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, trips })); } catch { setStorageError(true); } }, [trips, mode]);
  useEffect(() => { if (mode !== 'demo') return; setTrips(previous => previous.map(item => withCurrentMember(item, currentMember))); }, [currentMember, mode]);
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; if (mode !== 'loading') { try { localStorage.setItem('raskidai:theme', dark ? 'dark' : 'light'); } catch { /* Theme remains available in memory. */ } } }, [dark, mode]);
  async function refreshLive() {
    const response = await fetch('/api/app', { credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Не удалось обновить данные');
    setTrips(data.trips);
  }
  async function perform(action: string, values: Record<string, unknown>, message: string) {
    try { await api(action, values); await refreshLive(); setModal(null); notify(message); }
    catch (error) { notify((error as Error).message); }
  }
  async function initTelegram() {
    if (launchAttempt.current) return;
    launchAttempt.current = true;
    const tg = window.Telegram?.WebApp;
    if (!tg?.initData) {
      if (hasTelegramLaunchParams()) { setAuthError('Telegram не передал данные входа'); setMode('error'); }
      else enterDemo();
      return;
    }
    setMode('loading'); setAuthError('');
    tg.ready(); tg.expand(); setDark(tg.colorScheme === 'dark');
    tg.setHeaderColor?.(tg.colorScheme === 'dark' ? '#101115' : '#ffffff');
    tg.setBackgroundColor?.(tg.colorScheme === 'dark' ? '#101115' : '#ffffff');
    if (!tg.isFullscreen) tg.requestFullscreen?.();
    try {
      const data = await api('login', { initData: tg.initData });
      const verified = telegramMember({ first_name: data.user.firstName, last_name: data.user.lastName, username: data.user.username });
      if (verified) setCurrentMember(verified);
      setTrips(data.trips); setTelegramReady(true); setMode('live');
      const token = new URLSearchParams(tg.initData).get('start_param') || new URLSearchParams(location.search).get('tgWebAppStartParam');
      if (token) {
        try { await api('join', { token }); await refreshLive(); notify('Вы присоединились к мероприятию'); }
        catch (error) { notify((error as Error).message); }
      }
    } catch (error) { setAuthError((error as Error).message); setMode('error'); }
  }
  useEffect(() => {
    if (!live) return;
    const update = () => { if (document.visibilityState === 'visible') refreshLive().catch(error => notify(error.message)); };
    document.addEventListener('visibilitychange', update);
    const interval = setInterval(update, 10000);
    return () => { document.removeEventListener('visibilitychange', update); clearInterval(interval); };
  }, [live]);
  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (!telegramReady || !tg) return;
    const updateTheme = () => { const isDark = tg.colorScheme === 'dark'; setDark(isDark); tg.setHeaderColor?.(isDark ? '#101115' : '#ffffff'); tg.setBackgroundColor?.(isDark ? '#101115' : '#ffffff'); };
    tg.onEvent('themeChanged', updateTheme);
    return () => tg.offEvent('themeChanged', updateTheme);
  }, [telegramReady]);
  useEffect(() => {
    if (!live) return;
    const tg = window.Telegram?.WebApp;
    tg?.setHeaderColor?.(dark ? '#101115' : '#ffffff');
    tg?.setBackgroundColor?.(dark ? '#101115' : '#ffffff');
  }, [dark, live]);
  useEffect(() => {
    const tg = window.Telegram?.WebApp; if (!telegramReady || !tg?.initData) return;
    const back = () => { if (modal) setModal(null); else setTripId(null); };
    if (tripId || modal) tg.BackButton.show(); else tg.BackButton.hide();
    tg.BackButton.onClick(back);
    return () => tg.BackButton.offClick(back);
  }, [tripId, modal, telegramReady]);
  function updateTrip(fn: (current: Trip) => Trip) { setTrips(current => current.map(t => t.id === tripId ? fn(t) : t)); }
  function confirmPending(settlementId: string, actorId: string) {
    if (live && trip) { void perform('confirmTransfer', { eventId: trip.id, id: settlementId }, 'Получение подтверждено. Балансы обновлены'); return; }
    updateTrip(current => confirmPendingSettlement(current, settlementId, actorId)); setModal(null); notify('Получение подтверждено. Балансы обновлены');
  }
  function openTrip(id: string) { setTripId(id); setTripTab('expenses'); setTab('trips'); window.scrollTo({ top: 0 }); }
  function changeTab(next: Tab) { setTab(next); setTripId(null); window.scrollTo({ top: 0 }); }
  const visibleTrips = trips.filter(t => t.archived === archived);
  const availableMembers = members.map(member => member.id === ME ? currentMember : member);
  const currentBalance = trip ? balances(trip) : {};
  const pendingSettlements = trip?.settlements.filter(item => item.status === 'pending') || [];
  const moves = trip ? transfers(trip, true) : [];
  const myPending = pendingSettlements.filter(canMarkSettlement);
  const otherPending = pendingSettlements.filter(item => !canMarkSettlement(item));
  const myMoves = moves.filter(move => live ? move.from === ME : canMarkSettlement(move));
  const otherMoves = moves.filter(move => !canMarkSettlement(move));
  const outstandingCount = moves.length + pendingSettlements.length;
  const outstandingAmount = moves.reduce((sum, move) => sum + move.amount, 0) + pendingSettlements.reduce((sum, item) => sum + item.amount, 0);
  const demoPending = modal?.type === 'demo-confirm' ? pendingSettlements.find(item => item.id === modal.settlementId) : undefined;

  if (mode === 'loading' || mode === 'error') return <>
    <Script src="https://telegram.org/js/telegram-web-app.js" strategy="afterInteractive" onReady={() => { void initTelegram(); }} onError={() => { if (hasTelegramLaunchParams()) { setAuthError('Не удалось загрузить Telegram WebApp'); setMode('error'); } else enterDemo(); }} />
    <div className="app-shell startup-screen"><div className={`launch-wordmark ${mode === 'loading' ? 'is-loading' : 'is-ready'}`} role={mode === 'loading' ? 'status' : undefined}>Раскидай</div>
      {mode === 'error' && <div className="startup-error"><p role="alert">Не удалось подтвердить Telegram-вход: {authError}.</p><button className="primary-button" onClick={() => { launchAttempt.current = false; if (window.Telegram?.WebApp) void initTelegram(); else location.reload(); }}>Попробовать снова</button><button className="secondary-button" onClick={enterDemo}>Открыть демо</button></div>}
    </div>
  </>;

  return <>
    <Script src="https://telegram.org/js/telegram-web-app.js" strategy="afterInteractive" onReady={() => { void initTelegram(); }} />
    <div className={trip ? 'app-shell' : 'app-shell overview-shell'}>
      <div className="launch-wordmark is-ready">Раскидай</div>
      {trip && <header className="mini-header">
        <button className="back-link" onClick={() => setTripId(null)}><ArrowLeft size={20} /><span>Мероприятия</span></button>
        <div className="header-actions"><button className="icon-button" onClick={() => setModal({ type: 'menu' })} aria-label="Меню мероприятия"><Ellipsis size={23} /></button></div>
      </header>}
      {storageError && <div className="storage-warning" role="alert">Браузер не разрешает сохранение. Данные доступны до закрытия страницы.</div>}
      <main>
        {!trip && tab === 'trips' && <div className="screen home-screen">
          <div className="page-heading"><h1>Мои мероприятия</h1>{!live && <span className="demo-badge">демо</span>}</div>
          <div className="section-heading"><h2>{archived ? 'Завершённые мероприятия' : 'Активные'} <span>{visibleTrips.length}</span></h2><button className="text-button" onClick={() => setArchived(!archived)}>{archived ? 'Активные' : 'Архив'}{archived ? <CalendarDays size={15} /> : <Archive size={15} />}</button></div>
          <div className="trip-list">{visibleTrips.map(item => <TripCard key={item.id} trip={item} onOpen={() => openTrip(item.id)} />)}</div>
          {!visibleTrips.length && <div className="empty-state"><CalendarDays size={35} /><h3>{archived ? 'Архив пуст' : 'Пока нет мероприятий'}</h3><p>{archived ? 'Завершённые мероприятия появятся здесь.' : 'Создайте мероприятие и пригласите участников.'}</p></div>}
        </div>}

        {trip && <div className="screen trip-screen">
          <div className="trip-identity"><TripSymbol cover={trip.cover} /><div className="trip-identity-copy"><h1 title={trip.name}>{trip.name}</h1><p><CalendarDays size={14} />{trip.dates}{trip.archived && <span>· Завершено</span>}</p></div></div>
          <button className="members-row" onClick={() => setModal({ type: 'members' })}><Avatars people={trip.members} /><span className="text-button">Участники <ChevronRight size={15} /></span></button>
          <div className="trip-segments" role="tablist" aria-label="Разделы мероприятия">{(['expenses', 'balances', 'summary'] as TripTab[]).map(value => <button key={value} role="tab" aria-selected={tripTab === value} onClick={() => setTripTab(value)} className={tripTab === value ? 'active' : ''}>{value === 'expenses' ? 'Расходы' : value === 'balances' ? 'Балансы' : 'Сводка'}</button>)}</div>
          <div key={tripTab} className="tab-content" role="tabpanel">
            {tripTab === 'expenses' && <><div className="expense-total"><div><span>Моя доля</span><strong>{money(trip.expenses.reduce((sum, expense) => sum + (expense.splits[ME] || 0), 0))}</strong></div><div><span>Всего потратили</span><strong>{money(trip.expenses.reduce((sum, expense) => sum + expense.amount, 0))}</strong></div></div>
              {trip.expenses.length ? [...new Set(trip.expenses.map(e => e.date))].sort().reverse().map(date => <section className="expense-group" key={date}><h3>{dateLabel(date)}</h3><div className="list-surface">{trip.expenses.filter(e => e.date === date).map(expense => <button className="expense-row" key={expense.id} onClick={() => setModal({ type: 'details', expense })}><CategoryIcon category={expense.category} /><div className="row-copy"><strong>{expense.title}</strong><span>Плательщик: <MemberName id={expense.payer} trip={trip} /> · {splitNames[expense.mode].toLowerCase()}</span></div><div className="row-amount"><strong>{money(expense.amount)}</strong><span>моя доля {money(expense.splits[ME] || 0)}</span></div></button>)}</div></section>) : <div className="empty-state"><Wallet size={34} /><h3>Расходов пока нет</h3><p>Добавьте первый расход мероприятия.</p></div>}
              {trip.settlements.length > 0 && <section className="expense-group"><h3>Погашения</h3><div className="list-surface">{trip.settlements.map(s => <div className="expense-row" key={s.id}><span className={`category-icon ${s.status === 'pending' ? 'pending-icon' : 'positive'}`}>{s.status === 'pending' ? <Clock3 size={21} /> : <CheckCheck size={21} />}</span><div className="row-copy"><strong><MemberName id={s.from} trip={trip} /> → <MemberName id={s.to} trip={trip} /></strong><span>{dateLabel(s.date)} · {s.status === 'pending' ? 'Ожидает подтверждения' : 'долг погашен'}</span></div><strong>{money(s.amount)}</strong></div>)}</div></section>}
            </>}
            {tripTab === 'balances' && <>
              <div className={`personal-balance ${currentBalance[ME] < 0 ? 'owed' : ''}`}><span className="personal-icon">{currentBalance[ME] >= 0 ? <ArrowDownLeft size={25} /> : <ArrowUpRight size={25} />}</span><p>{currentBalance[ME] === 0 ? 'Ваш баланс' : currentBalance[ME] > 0 ? 'Вам вернут' : 'Вам осталось вернуть'}</p><strong>{money(Math.abs(currentBalance[ME] || 0))}</strong><span>{pendingSettlements.length ? 'Ожидающие подтверждения переводы пока не учтены' : currentBalance[ME] === 0 ? 'Всё сошлось. Можно просто отдыхать.' : 'Все расходы и погашения уже учтены'}</span></div>
              <div className="section-heading"><h2>Кто кому переводит</h2><span className="subtle-pill">{outstandingCount} {plural(outstandingCount, ['перевод', 'перевода', 'переводов'])}</span></div>
              {outstandingCount ? <div className="transfer-list">
                {(myPending.length > 0 || myMoves.length > 0) && <section className="transfer-group"><h3>Мои</h3>{myPending.map(item => <TransferCard key={item.id} trip={trip} move={item} pending={item} onConfirm={item.to === ME ? () => confirmPending(item.id, ME) : undefined} onDemoConfirm={item.from === ME && !telegramReady ? () => setModal({ type: 'demo-confirm', settlementId: item.id }) : undefined} />)}{myMoves.map(move => <TransferCard key={move.from + move.to} trip={trip} move={move} onSettle={() => setModal({ type: 'settlement', move })} />)}</section>}
                {(otherPending.length > 0 || otherMoves.length > 0) && <section className="transfer-group"><h3>Остальные</h3>{otherPending.map(item => <TransferCard key={item.id} trip={trip} move={item} pending={item} />)}{otherMoves.map(move => <TransferCard key={move.from + move.to} trip={trip} move={move} />)}</section>}
              </div> : <div className="settled-state"><span><CheckCheck size={28} /></span><h3>Все в расчёте!</h3><p>Долгов больше нет.</p></div>}
              <div className="section-heading"><h2>Балансы участников</h2><Info size={16} className="muted" /></div><div className="list-surface">{trip.members.map(member => <div className="member-balance" key={member.id}><Avatar member={member} /><div><strong><DisplayMemberName member={member} /></strong><span>{currentBalance[member.id] > 0 ? 'получит' : currentBalance[member.id] < 0 ? 'вернёт' : 'в расчёте'}</span></div><strong className={currentBalance[member.id] > 0 ? 'positive-text' : currentBalance[member.id] < 0 ? 'negative-text' : 'muted'}>{money(currentBalance[member.id], true)}</strong></div>)}</div><p className="help-note">Предлагаем переводы, чтобы рассчитаться за меньшее число действий.</p>
            </>}
            {tripTab === 'summary' && <Summary trip={trip} />}
          </div>
        </div>}

        {!trip && tab === 'activity' && <div className="screen"><h1>Активность</h1><p className="page-description">Расходы и погашения по всем мероприятиям.</p><div className="activity-list">{trips.flatMap(t => [...t.expenses.map(e => ({ id: e.id, date: e.date, title: e.title, amount: e.amount, trip: t, kind: 'expense', payer: e.payer, category: e.category, pending: false })), ...t.settlements.map(s => ({ id: s.id, date: s.date, title: s.status === 'pending' ? 'Ожидает подтверждения' : 'Долг погашен', amount: s.amount, trip: t, kind: 'settlement', payer: s.from, category: 'other' as Category, pending: s.status === 'pending' }))]).sort((a, b) => b.date.localeCompare(a.date)).map(item => <button className="activity-row" key={item.id} onClick={() => openTrip(item.trip.id)}><span className="timeline-dot">{item.kind === 'settlement' ? item.pending ? <Clock3 size={19} /> : <CheckCheck size={19} /> : <CategoryIcon category={item.category} />}</span><div><small>{dateLabel(item.date)} · {item.trip.name}</small><strong>{item.title}</strong><span><MemberName id={item.payer} trip={item.trip} /> · {money(item.amount)}</span></div><ChevronRight size={16} /></button>)}</div></div>}
        {!trip && tab === 'profile' && <div className="screen"><h1>Профиль</h1><div className="profile-card"><Avatar member={currentMember} /><div className="profile-details"><h2><DisplayMemberName member={currentMember} /></h2>{currentMember.username && <p>{currentMember.username}</p>}<span className="subtle-pill"><Send size={13} /> {live ? 'Профиль Telegram' : 'Тестовый Telegram-аккаунт'}</span></div></div><div className="list-surface settings"><button role="switch" aria-checked={dark} aria-label="Тёмная тема" onClick={() => setDark(!dark)}>{dark ? <Sun size={21} /> : <Moon size={21} />}<span>Тёмная тема</span><span className={`toggle ${dark ? 'on' : ''}`} aria-hidden="true"><i /></span></button><button onClick={() => { setArchived(true); changeTab('trips'); }}><Archive size={21} /><span>Архив мероприятий</span><ChevronRight size={18} /></button>{!live && <button onClick={() => setModal({ type: 'reset' })}><RotateCcw size={21} /><span>Начать демо заново</span><ChevronRight size={18} /></button>}</div><div className="prototype-note"><span className="brand-icon"><ArrowLeftRight size={22} /></span><h3>Раскидай и отдыхай</h3><p>{live ? 'Расходы синхронизируются между участниками мероприятия.' : 'Демо на тестовых данных. Изменения сохраняются в этом браузере.'}</p></div></div>}
      </main>
      {!trip && tab === 'trips' && !archived && <div className="event-dock"><button className="primary-button" onClick={() => setModal({ type: 'create' })}><Plus size={20} />Новое мероприятие</button></div>}
      {trip && !trip.archived && <div className="expense-dock"><button className="primary-button" onClick={() => setModal({ type: 'expense' })}><Plus size={20} />Добавить расход</button></div>}
      {!trip && <nav className="bottom-nav" aria-label="Основная навигация" data-active={tab}>{([{ id: 'trips', label: 'Мероприятия', icon: CalendarDays }, { id: 'activity', label: 'Активность', icon: Clock3 }, { id: 'profile', label: 'Профиль', icon: UserRound }] as const).map(item => <button key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => changeTab(item.id)} aria-current={tab === item.id ? 'page' : undefined}><item.icon size={23} strokeWidth={tab === item.id ? 2.2 : 1.7} /><span>{item.label}</span></button>)}</nav>}
      {toast && <div className="toast" role="status"><span><Check size={16} /></span>{toast}</div>}
    </div>

    {modal?.type === 'create' && <Sheet title="Новое мероприятие" onClose={() => setModal(null)}><CreateTrip allMembers={live ? [currentMember] : availableMembers} live={live} onCreate={newTrip => { if (live) { void (async () => { try { await api('createEvent', { id: newTrip.id, name: newTrip.name, cover: newTrip.cover }); await refreshLive(); openTrip(newTrip.id); setModal(null); notify('Мероприятие создано'); } catch (error) { notify((error as Error).message); } })(); return; } setTrips(previous => [newTrip, ...previous]); openTrip(newTrip.id); setModal(null); notify('Мероприятие создано'); }} /></Sheet>}
    {modal?.type === 'expense' && trip && <Sheet title={modal.expense ? 'Изменить расход' : 'Новый расход'} onClose={() => setModal(null)}><ExpenseForm key={modal.expense?.id || 'new'} trip={trip} expense={modal.expense} onSave={(expense, requestId) => { if (live) { void perform('saveExpense', { eventId: trip.id, expense, requestId, expectedVersion: modal.expense?.version ?? null }, modal.expense ? 'Расход изменён' : 'Расход добавлен. Всё раскидали!'); return; } updateTrip(t => ({ ...t, expenses: modal.expense ? t.expenses.map(e => e.id === expense.id ? expense : e) : [expense, ...t.expenses] })); setModal(null); setTripTab('expenses'); notify(modal.expense ? 'Расход изменён' : 'Расход добавлен. Всё раскидали!'); }} /></Sheet>}
    {modal?.type === 'settlement' && trip && canMarkSettlement(modal.move) && <Sheet title={modal.move.from === ME ? 'Я перевел' : 'Я получил'} onClose={() => setModal(null)}><SettlementForm trip={trip} move={modal.move} onSave={(amount, date, id) => { const move = modal.move; if (!canMarkSettlement(move)) return; if (live) { if (move.from !== ME) return; void perform('createTransfer', { eventId: trip.id, id, to: move.to, amount, date }, 'Перевод ожидает подтверждения получателя'); return; } const outgoing = move.from === ME; updateTrip(t => ({ ...t, settlements: [{ id: uid(), from: move.from, to: move.to, amount, date, status: outgoing ? 'pending' : 'confirmed', confirmedBy: outgoing ? undefined : ME }, ...t.settlements] })); setModal(null); notify(outgoing ? 'Перевод ожидает подтверждения получателя' : 'Получение подтверждено. Балансы обновлены'); }} /></Sheet>}
    {modal?.type === 'demo-confirm' && trip && demoPending && !telegramReady && <Sheet title="Демо: подтверждение" onClose={() => setModal(null)}><div className="sheet-body"><p className="form-intro">В рабочем приложении получение подтвердит второй участник в своём аккаунте. Здесь можно проверить этот шаг на тестовых данных.</p><div className="demo-transfer-preview"><strong><MemberName id={demoPending.from} trip={trip} /> → <MemberName id={demoPending.to} trip={trip} /></strong><span>{money(demoPending.amount)}</span></div><button className="primary-button" onClick={() => confirmPending(demoPending.id, demoPending.to)}><CheckCheck size={19} />Подтвердить за получателя</button><button className="secondary-button" onClick={() => setModal(null)}>Отмена</button></div></Sheet>}
    {modal?.type === 'members' && trip && <Sheet title="Участники" onClose={() => setModal(null)}><div className="sheet-body"><p className="form-intro">В мероприятии {trip.members.length} {plural(trip.members.length, ['участник', 'участника', 'участников'])}.</p><div className="list-surface">{trip.members.map(m => <div className="member-balance" key={m.id}><Avatar member={m} /><div><strong><DisplayMemberName member={m} /></strong>{m.username && <span>{m.username}</span>}</div>{m.id === trip.ownerId || (!live && m.id === ME) ? <span className="subtle-pill">Создатель</span> : <Check size={18} className="positive-text" />}</div>)}</div>{live ? <InviteLink key={trip.id} eventId={trip.id} /> : <>{availableMembers.filter(m => !trip.members.some(p => p.id === m.id)).map(member => <button className="add-member-button" key={member.id} aria-label={`Добавить участника ${member.name}`} onClick={() => { updateTrip(t => ({ ...t, members: [...t.members, member] })); notify(`${member.name} теперь в мероприятии`); }}><Avatar member={member} small /><span>{member.name}</span><Plus size={18} /></button>)}<p className="help-note">В демо можно добавлять тестовых друзей.</p></>}</div></Sheet>}
    {modal?.type === 'details' && trip && <Sheet title="Расход" onClose={() => setModal(null)}><ExpenseDetails trip={trip} expense={modal.expense} canEdit={!live || modal.expense.author === ME || trip.ownerId === ME} onEdit={() => setModal({ type: 'expense', expense: modal.expense })} onDelete={() => { if (live) { void perform('deleteExpense', { eventId: trip.id, id: modal.expense.id, version: modal.expense.version }, 'Расход удалён, балансы пересчитаны'); return; } updateTrip(t => ({ ...t, expenses: t.expenses.filter(e => e.id !== modal.expense.id) })); setModal(null); notify('Расход удалён, балансы пересчитаны'); }} /></Sheet>}
    {modal?.type === 'menu' && trip && <Sheet title="Настройки мероприятия" onClose={() => setModal(null)}><div className="sheet-body"><button className="menu-row" onClick={() => setModal({ type: 'members' })}><UsersRound size={22} /><span>Участники мероприятия</span><ChevronRight size={18} /></button>{(!live || trip.ownerId === ME) && <button className="menu-row" onClick={() => { if (trip.archived) { if (live) { void perform('archive', { eventId: trip.id, archived: false }, 'Мероприятие снова активно'); return; } updateTrip(t => ({ ...t, archived: false })); setModal(null); notify('Мероприятие снова активно'); } else setModal({ type: 'archive' }); }}><Archive size={22} /><span>{trip.archived ? 'Вернуть из архива' : 'Завершить мероприятие'}</span><ChevronRight size={18} /></button>}<button className="menu-row" onClick={() => { setDark(!dark); setModal(null); }}><Moon size={22} /><span>{dark ? 'Светлая тема' : 'Тёмная тема'}</span><ChevronRight size={18} /></button></div></Sheet>}
    {modal?.type === 'archive' && trip && <Sheet title={outstandingCount ? 'Сначала завершите расчёты' : 'Завершить мероприятие?'} onClose={() => setModal(null)}><div className="sheet-body archive-sheet">{outstandingCount ? <><p className="form-intro">Мероприятие можно отправить в архив, когда все долги погашены и переводы подтверждены. Сейчас осталось {outstandingCount} {plural(outstandingCount, ['перевод', 'перевода', 'переводов'])} на {money(outstandingAmount)}{pendingSettlements.length ? `; ${pendingSettlements.length} ${plural(pendingSettlements.length, ['ожидает', 'ожидают', 'ожидают'])} подтверждения` : ''}.</p><button className="primary-button" onClick={() => { setModal(null); setTripTab('balances'); }}>Посмотреть балансы</button><button className="secondary-button" onClick={() => setModal(null)}>Закрыть</button></> : <><p className="form-intro">Все расчёты закрыты. Мероприятие будет перемещено в архив.</p><button className="primary-button" onClick={() => { if (transfers(trip).length || trip.settlements.some(item => item.status === 'pending')) return; if (live) { void perform('archive', { eventId: trip.id, archived: true }, 'Мероприятие перенесено в архив'); return; } updateTrip(t => ({ ...t, archived: true })); setModal(null); notify('Мероприятие перенесено в архив'); }}>Завершить и архивировать</button><button className="secondary-button" onClick={() => setModal(null)}>Отмена</button></>}</div></Sheet>}
    {modal?.type === 'reset' && <Sheet title="Начать сначала?" onClose={() => setModal(null)}><div className="sheet-body"><p className="form-intro">Ваши изменения в прототипе будут удалены. Вернём три тестовых мероприятия и исходные расходы.</p><button className="primary-button" onClick={() => { setTrips(seedTrips().map(item => withCurrentMember(item, currentMember))); setTripId(null); setArchived(false); setTab('trips'); setModal(null); notify('Демо готово к новому мероприятию'); }}>Восстановить тестовые данные</button><button className="secondary-button" onClick={() => setModal(null)}>Оставить как есть</button></div></Sheet>}
  </>;
}

function TripCard({ trip, onOpen }: { trip: Trip; onOpen: () => void }) {
  const balance = balances(trip)[ME] || 0;
  return <button className="trip-card" onClick={onOpen} aria-label={`Открыть мероприятие ${trip.name}`}>
    <TripSymbol cover={trip.cover} />
    <span className="card-info"><strong title={trip.name}>{trip.name}</strong><span className="card-date">{trip.dates} · {trip.members.length} {plural(trip.members.length, ['участник', 'участника', 'участников'])}</span><span className={`card-balance ${balance < 0 ? 'negative-text' : balance > 0 ? 'positive-text' : 'muted'}`}>{balance === 0 ? 'Все в расчёте' : balance > 0 ? `Вам вернут ${money(balance)}` : `Вы должны ${money(-balance)}`}</span></span><ChevronRight size={20} className="compact-arrow" />
  </button>;
}

function CreateTrip({ allMembers, onCreate, live = false }: { allMembers: Member[]; onCreate: (trip: Trip) => void; live?: boolean }) {
  const draftId = useRef(uid());
  const [name, setName] = useState(''), [cover, setCover] = useState('default'), [friends, setFriends] = useState<string[]>([]), [error, setError] = useState('');
  return <form className="sheet-body create-trip-form" onSubmit={event => { event.preventDefault(); if (!name.trim()) { setError('Введите название мероприятия'); return; } onCreate({ id: draftId.current, name: name.trim(), subtitle: '', cover, dates: 'Новое мероприятие', members: allMembers.filter(m => m.id === ME || friends.includes(m.id)), expenses: [], settlements: [], archived: false }); }}>
    <label className="field-label" htmlFor="trip-name">Название мероприятия</label><input id="trip-name" className="text-input" placeholder="Например, ужин с друзьями" value={name} maxLength={60} onChange={e => { setName(e.target.value); setError(''); }} />
    <div className="field-label" id="trip-icon-label">Иконка мероприятия</div><div className="event-icon-picker" role="group" aria-labelledby="trip-icon-label">{tripSymbolChoices.map(option => <button type="button" key={option.id} className={cover === option.id ? 'selected' : ''} aria-label={option.label} aria-pressed={cover === option.id} title={option.label} onClick={() => setCover(option.id)}><span aria-hidden="true">{tripSymbols[option.id]}</span></button>)}</div>
    {!live && <><label className="field-label">Друзья для демо <span>необязательно</span></label><div className="friend-picker">{allMembers.filter(member => member.id !== ME).map(member => <button type="button" key={member.id} aria-pressed={friends.includes(member.id)} className={friends.includes(member.id) ? 'selected' : ''} onClick={() => setFriends(previous => previous.includes(member.id) ? previous.filter(id => id !== member.id) : [...previous, member.id])}><Avatar member={member} small /><span>{member.name}</span>{friends.includes(member.id) ? <Check size={16} /> : <Plus size={16} />}</button>)}</div></>}<p className="help-note">Вы — первый участник. Можно начать одному и пригласить друзей по ссылке.</p>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button" type="submit"><CalendarDays size={18} />Создать мероприятие</button>
  </form>;
}

function ExpenseForm({ trip, expense, onSave }: { trip: Trip; expense?: Expense; onSave: (expense: Expense, requestId: string) => void }) {
  const draftId = useRef(expense?.id || uid());
  const request = useRef({ id: uid(), fingerprint: '' });
  const [amount, setAmount] = useState(expense ? String(expense.amount / 100).replace('.', ',') : '');
  const [title, setTitle] = useState(expense?.title || ''), [category, setCategory] = useState<Category>(expense?.category || 'food'), [date, setDate] = useState(expense?.date || today());
  const payer = expense?.payer || ME;
  const authorName = trip.members.find(member => member.id === ME)?.name || members[0].name;
  const [selected, setSelected] = useState(expense ? Object.keys(expense.splits) : trip.members.map(m => m.id));
  const [mode, setMode] = useState<SplitMode>(expense?.mode === 'shares' ? 'percent' : expense?.mode || 'equal'), [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(trip.members.map(m => [m.id, expense && expense.mode !== 'equal' ? (expense.mode === 'percent' || expense.mode === 'shares' ? String((expense.splits[m.id] || 0) / expense.amount * 100) : String((expense.splits[m.id] || 0) / 100)) : '1'])));
  const [error, setError] = useState('');
  let preview: Record<string, number> = {}, previewError = '';
  if (amount) { try { preview = distribute(parseMoney(amount), selected, mode, values); } catch (err) { previewError = (err as Error).message; } }
  function chooseMode(next: SplitMode) {
    setMode(next); setError('');
    let total = 0; try { total = parseMoney(amount); } catch { /* Empty amount is valid while typing. */ }
    const defaults = Object.fromEntries(selected.map((id, i) => [id, next === 'percent' ? String(Math.floor(100 / selected.length) + (i === 0 ? 100 % selected.length : 0)) : next === 'exact' ? String((Math.floor(total / selected.length) + (i === 0 ? total % selected.length : 0)) / 100) : '1']));
    setValues(defaults);
  }
  return <form className="sheet-body expense-form" onSubmit={event => { event.preventDefault(); try { if (!title.trim()) throw new Error('Добавьте название расхода'); if (!date) throw new Error('Выберите дату расхода'); const cents = parseMoney(amount); const splits = distribute(cents, selected, mode, values); const saved = { id: draftId.current, title: title.trim(), amount: cents, payer, splits, category, date, mode, author: expense?.author || ME, history: [...(expense?.history || []), expense ? `Расход изменён пользователем: ${authorName}` : `Расход добавлен пользователем: ${authorName}`] }; const fingerprint = JSON.stringify(saved); if (request.current.fingerprint !== fingerprint) request.current = { id: uid(), fingerprint }; onSave(saved, request.current.id); } catch (err) { setError((err as Error).message); } }}>
    <div className="amount-input-area"><label htmlFor="expense-amount">Сколько потратили?</label><div><input id="expense-amount" inputMode="decimal" placeholder="0" value={amount} onChange={e => { setAmount(e.target.value); setError(''); }} maxLength={15} style={{ width: `${Math.max(amount.length, 1) + 0.5}ch` }} /><span>₽</span></div></div>
    <label className="field-label" htmlFor="expense-title">На что?</label><input className="text-input" id="expense-title" placeholder="Например, ужин после прогулки" value={title} maxLength={80} onChange={e => setTitle(e.target.value)} />
    <label className="field-label">Категория</label><div className="category-picker">{categories.map(c => { const Icon = categoryIcons[c.id]; return <button key={c.id} type="button" className={category === c.id ? 'selected' : ''} onClick={() => setCategory(c.id)} aria-pressed={category === c.id}><Icon size={19} /><span>{c.name}</span></button>; })}</div>
    <label className="expense-date-field"><span className="field-label">Дата</span><input className="text-input" type="date" value={date} onChange={e => setDate(e.target.value)} aria-label="Дата расхода" /></label>
    <div className="split-heading"><h3>Как раскидать?</h3><span>{selected.length} из {trip.members.length}</span></div><div className="split-segments" role="group" aria-label="Способ распределения">{availableSplitModes.map(value => <button type="button" key={value} className={mode === value ? 'active' : ''} onClick={() => chooseMode(value)} aria-pressed={mode === value}>{splitNames[value]}</button>)}</div>
    <div className="split-members">{trip.members.map(member => <div className="split-member" key={member.id}><label><input type="checkbox" checked={selected.includes(member.id)} onChange={e => { setSelected(previous => e.target.checked ? [...previous, member.id] : previous.filter(id => id !== member.id)); setError(''); }} /><Avatar member={member} small /><span><DisplayMemberName member={member} /></span></label>{selected.includes(member.id) && (mode === 'equal' ? <strong>{money(preview[member.id] || 0)}</strong> : <div className="split-value"><input aria-label={`${splitNames[mode]}: ${member.name}${member.id === ME ? " (Вы)" : ""}`} inputMode="decimal" value={values[member.id] || ''} onChange={e => setValues(previous => ({ ...previous, [member.id]: e.target.value }))} /><span>{mode === 'percent' ? '%' : mode === 'exact' ? '₽' : 'д.'}</span></div>)}</div>)}</div>
    {mode !== 'equal' && <p className={previewError ? 'split-validation invalid' : 'split-validation'}>{previewError || `Всё сходится: ${money(Object.values(preview).reduce((a, b) => a + b, 0))}`}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button" type="submit"><Check size={19} />{expense ? 'Сохранить изменения' : 'Добавить расход'}</button><p className="help-note centered">Балансы пересчитаем сразу после сохранения</p>
  </form>;
}

function SettlementForm({ trip, move, onSave }: { trip: Trip; move: Move; onSave: (amount: number, date: string, id: string) => void }) {
  const draftId = useRef(uid());
  const [amount, setAmount] = useState(String(move.amount / 100).replace('.', ',')), [date, setDate] = useState(today()), [error, setError] = useState('');
  const outgoing = move.from === ME;
  return <form className="sheet-body" onSubmit={event => { event.preventDefault(); try { const cents = parseMoney(amount); if (cents > move.amount) throw new Error(`Осталось вернуть ${money(move.amount)}. Укажите эту сумму или меньше.`); if (!date) throw new Error('Выберите дату возврата'); onSave(cents, date, draftId.current); } catch (err) { setError((err as Error).message); } }}>
    <div className="settlement-people"><div><Avatar member={trip.members.find(m => m.id === move.from)!} /><strong><MemberName id={move.from} trip={trip} /></strong><span>отправляет</span></div><ArrowRight size={24} /><div><Avatar member={trip.members.find(m => m.id === move.to)!} /><strong><MemberName id={move.to} trip={trip} /></strong><span>получает</span></div></div>
    <div className="amount-input-area settlement-amount-area"><label htmlFor="settlement-amount">Сумма возврата</label><div><input id="settlement-amount" inputMode="decimal" value={amount} onChange={e => { setAmount(e.target.value); setError(''); }} maxLength={15} style={{ width: `${Math.max(amount.length, 1) + 0.5}ch` }} /><span>₽</span></div></div>
    <label className="field-label" htmlFor="settlement-date">Когда вернули</label><input id="settlement-date" className="text-input" type="date" value={date} onChange={e => setDate(e.target.value)} /><div className="settlement-note"><Info size={18} /><p>{outgoing ? 'После вашего подтверждения перевод будет ждать ответа получателя. До этого баланс не изменится.' : 'Подтвердите, что получили перевод. После этого балансы обновятся.'} Деньги через приложение не отправляются.</p></div>{error && <p className="form-error" role="alert">{error}</p>}<button type="submit" className="primary-button"><CheckCheck size={19} />{outgoing ? 'Отправить на подтверждение' : 'Подтвердить получение'}</button>
  </form>;
}

function ExpenseDetails({ expense, trip, onEdit, onDelete, canEdit = true }: { expense: Expense; trip: Trip; onEdit: () => void; onDelete: () => void; canEdit?: boolean }) {
  const [deleting, setDeleting] = useState(false);
  return <div className="sheet-body"><div className="detail-header"><CategoryIcon category={expense.category} /><h3>{expense.title}</h3><strong>{money(expense.amount)}</strong><p>{dateLabel(expense.date)} · {categories.find(c => c.id === expense.category)?.name}</p></div><div className="detail-payer"><span>Плательщик</span><strong><MemberName id={expense.payer} trip={trip} /></strong></div><div className="split-heading"><h3>Распределение</h3><span>{splitNames[expense.mode]}</span></div><div className="list-surface">{Object.entries(expense.splits).map(([id, amount]) => <div className="member-balance" key={id}><Avatar member={trip.members.find(m => m.id === id)!} small /><strong><MemberName id={id} trip={trip} /></strong><strong>{money(amount)}</strong></div>)}</div><div className="history"><h4><Clock3 size={14} />История</h4>{expense.history.map((entry, i) => <p key={i}>{displayHistory(entry, trip)}</p>)}</div>{deleting ? <div className="delete-confirm"><p>Удалить расход? Балансы будут пересчитаны.</p><button className="danger-button" onClick={onDelete}>Да, удалить расход</button><button className="secondary-button" onClick={() => setDeleting(false)}>Отмена</button></div> : canEdit ? <div className="detail-actions"><button className="secondary-button" onClick={onEdit}><Pencil size={17} />Изменить</button><button className="secondary-button danger-text" onClick={() => setDeleting(true)}><Trash2 size={17} />Удалить</button></div> : null}</div>;
}

function Summary({ trip }: { trip: Trip }) {
  const total = trip.expenses.reduce((a, e) => a + e.amount, 0);
  const personal = personalSummary(trip, ME);
  const everyoneSettled = Object.values(balances(trip)).every(balance => balance === 0) && !trip.settlements.some(settlement => settlement.status === 'pending');
  const categoryTotals = Object.fromEntries(categories.map(c => [c.id, trip.expenses.filter(e => e.category === c.id).reduce((sum, e) => sum + e.amount, 0)]));
  const percentages = total ? distribute(100, categories.map(c => c.id), 'shares', Object.fromEntries(categories.map(c => [c.id, String(categoryTotals[c.id] / total)]))) : {};
  const resultLabel = personal.balance > 0 ? 'Осталось получить' : personal.balance < 0 ? 'Осталось вернуть' : 'Ваш остаток';
  const resultNote = !total ? 'Добавьте первый расход, чтобы увидеть расчёты.' : everyoneSettled ? 'Все участники в расчёте' : personal.balance === 0 && (personal.pendingIncoming || personal.pendingOutgoing) ? 'Ваши переводы ждут подтверждения' : personal.balance === 0 ? 'Вы в расчёте, у других остались переводы' : 'Расчёты ещё идут';
  return <>
    <div className="summary-overview">
      <div><span>Всего потратили</span><strong>{money(total)}</strong></div>
      <div><span>Моя доля</span><strong>{money(personal.share)}</strong></div>
    </div>
    <div className="section-heading summary-heading"><h2>Мои расчёты</h2></div>
    <section className="summary-reconciliation" aria-label="Мои расчёты">
      <div className="summary-paid"><span>Я оплатил</span><strong>{money(personal.paid)}</strong></div>
      <div className="summary-returned">
        <div><span>Мне вернули</span><strong>{money(personal.received)}</strong></div>
        <div><span>Я вернул</span><strong>{money(personal.returned)}</strong></div>
      </div>
      <div className={`summary-result ${personal.balance > 0 ? 'incoming' : personal.balance < 0 ? 'outgoing' : 'settled'}`}>
        <div><span>{resultLabel}</span><strong>{money(Math.abs(personal.balance))}</strong></div>
        <p>{resultNote}</p>
      </div>
      {(personal.pendingIncoming > 0 || personal.pendingOutgoing > 0) && <div className="summary-pending">
        <Clock3 size={16} />
        <div>
          {personal.pendingIncoming > 0 && <p>Мне переводят {money(personal.pendingIncoming)} — ждёт моего подтверждения</p>}
          {personal.pendingOutgoing > 0 && <p>Я перевёл {money(personal.pendingOutgoing)} — ждёт подтверждения получателя</p>}
          <small>Пока не учтено в расчётах выше</small>
        </div>
      </div>}
    </section>
    <div className="section-heading"><h2>На что потратили</h2><Shapes size={16} className="muted" /></div>
    {total > 0 ? <><div className="category-bar">{categories.map(c => { const sum = categoryTotals[c.id]; return sum ? <span key={c.id} style={{ width: `${sum / total * 100}%`, background: c.color }} title={`${c.name}: ${money(sum)}`} /> : null; })}</div><div className="list-surface">{categories.map(c => { const sum = categoryTotals[c.id]; return <div className="category-summary" key={c.id}><CategoryIcon category={c.id} /><span>{c.name}</span><div><strong>{money(sum)}</strong><small>{percentages[c.id]}%</small></div></div>; })}</div></> : <div className="empty-state"><Sparkles size={30} /><h3>Здесь появится сводка</h3><p>Добавьте первый расход, и мы покажем распределение трат.</p></div>}
    <div className="section-heading"><h2>Кто сколько оплатил</h2></div>
    <div className="list-surface">{trip.members.map(m => <div className="member-balance" key={m.id}><Avatar member={m} small /><strong><MemberName id={m.id} trip={trip} /></strong><strong>{money(trip.expenses.filter(e => e.payer === m.id).reduce((a, e) => a + e.amount, 0))}</strong></div>)}</div>
  </>;
}

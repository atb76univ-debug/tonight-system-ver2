(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const app = $('#app'), modalRoot = $('#modalRoot');
  const RSVP_KEY = 'tonight_visitor_rsvp_v1';
  const NOTICE_KEY = 'tonight_visitor_notice_v1';
  let data = {events:[],updated:0}, selectedId = null, page = 'home', lastPage = 'home';
  let refreshTimer = null;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = n => `¥${Number(n||0).toLocaleString('ja-JP')}`;
  const localDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const dateObj = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s||'')) ? new Date(`${s}T00:00:00`) : null;
  const dateLabel = s => { const d=dateObj(s); return d ? `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日（${'日月火水木金土'[d.getDay()]}）` : '日程未定'; };
  const rsvps = () => { try{return JSON.parse(localStorage.getItem(RSVP_KEY)||'{}')}catch{return {}} };
  const isRsvped = id => Boolean(rsvps()[id]);
  const saveRsvp = (id, value) => { const v=rsvps(); if(value)v[id]=true; else delete v[id]; localStorage.setItem(RSVP_KEY,JSON.stringify(v)); };
  const activeEvents = () => data.events.filter(e=>!e.archived).sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  const archivedEvents = () => data.events.filter(e=>e.archived).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const selected = () => data.events.find(e=>e.id===selectedId) || chooseFeatured();
  function chooseFeatured(){
    const list=activeEvents(); if(!list.length)return null;
    const today=localDate(new Date());
    return list.find(e=>(e.date||'')>=today) || list[list.length-1];
  }
  function flyerUrl(ev){return ev?.flyer?`/api/flyer/${encodeURIComponent(ev.id)}?v=${encodeURIComponent(ev.flyer)}`:'';}
  function addDays(date,days){const d=dateObj(date);if(!d)return date;d.setDate(d.getDate()+days);return localDate(d);}
  function eventDateTime(date,time){const d=dateObj(date);if(!d)return null;const [h,m]=String(time||'00:00').split(':').map(Number);d.setHours(h||0,m||0,0,0);return d;}
  function actRange(ev,act){
    const startDate=act.startDate||ev.date, endDate=act.endDate||(String(act.end||'')<String(act.start||'')?addDays(startDate,1):startDate);
    let start=eventDateTime(startDate,act.start), end=eventDateTime(endDate,act.end);
    if(!end && start && act.end){end=new Date(start);const [h,m]=act.end.split(':').map(Number);end.setHours(h||0,m||0,0,0);if(end<=start)end.setDate(end.getDate()+1);}
    const offset=Number(ev.tt?.offsetMinutes||0);
    if(start)start=new Date(start.getTime()+offset*60000);if(end)end=new Date(end.getTime()+offset*60000);
    return {start,end};
  }
  function actsFor(ev){return (Array.isArray(ev?.acts)?ev.acts:[]).slice().sort((a,b)=>(actRange(ev,a).start?.getTime()||0)-(actRange(ev,b).start?.getTime()||0));}
  function statusFor(ev){
    const now=new Date(), acts=actsFor(ev), ranges=acts.map(a=>({a,...actRange(ev,a)}));
    const current=ranges.find(x=>x.start&&x.end&&now>=x.start&&now<x.end);
    const next=ranges.find(x=>x.start&&x.start>now);
    const first=ranges.find(x=>x.start), last=ranges.filter(x=>x.end).at(-1);
    if(current)return {label:'LIVE',current,next};
    if(next && first && now<first.start)return {label:'開催前',current:null,next};
    if(next)return {label:'開催中',current:null,next};
    if(last && now>last.end)return {label:'終了',current:null,next:null};
    return {label:'開催予定',current:null,next};
  }
  function actNames(ev,act){
    const byId=new Map((ev.members||[]).map(m=>[String(m.id),m]));
    const ids=Array.isArray(act.memberIds)?act.memberIds:[];
    if(!ids.length)return String(act.name||'出演者未設定');
    const known=ids.map(id=>{const m=byId.get(String(id));return m?(m.nickname||m.name):'';}).filter(Boolean);
    const fallback=String(act.name||'').split('、').map(x=>x.trim()).filter(Boolean);
    return [...known,...fallback.slice(ids.length)].join('、')||'出演者未設定';
  }
  function timeText(ev,act){const r=actRange(ev,act);const f=d=>d?`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`:'--:--';return `${f(r.start)} – ${f(r.end)}`;}
  function statusPill(ev){const s=statusFor(ev);return `<span class="pill ${s.label==='LIVE'?'live':'blue'}">${s.label==='LIVE'?'<i class="live-dot"></i>':''}${esc(s.label)}</span>`;}
  function eventCard(ev){const image=flyerUrl(ev);return `<button class="event-tile" data-event="${esc(ev.id)}">${image?`<img src="${image}" alt="${esc(ev.name)} フライヤー" loading="lazy">`:`<div style="aspect-ratio:4/3;background:#e8e9ec;display:grid;place-items:center"><img src="../TMPlogo.png" style="width:35%;height:35%;object-fit:contain" alt=""></div>`}<div class="tile-copy"><strong>${esc(ev.name)}</strong><small>${esc(dateLabel(ev.date))}</small></div></button>`;}
  function setPage(next){page=next;document.querySelectorAll('.bottom-nav button').forEach(b=>b.classList.toggle('active',b.dataset.page===page));render();window.scrollTo({top:0,behavior:'smooth'});}
  function headerTitle(title,sub=''){return `<div class="eyebrow">TSUKUBA MUSIC PROJECT</div><h1 class="page-title">${esc(title)}</h1>${sub?`<p class="lead">${esc(sub)}</p>`:''}`;}
  function renderHome(){
    const ev=selected(); const upcoming=activeEvents().filter(e=>(e.date||'')>=localDate(new Date()));
    const hero=ev?`<button class="hero-card" data-event="${esc(ev.id)}">${flyerUrl(ev)?`<img src="${flyerUrl(ev)}" alt="">`:''}<div class="hero-copy"><div class="eyebrow">${statusPill(ev)}</div><h2>${esc(ev.name)}</h2><p>${esc(dateLabel(ev.date))}${ev.venue?` · ${esc(ev.venue)}`:''}</p></div></button>`:`<div class="empty"><strong>イベント情報はまだありません</strong>次回のtonight!をお楽しみに。</div>`;
    let nowBox='';
    if(ev){const st=statusFor(ev);const line=(label,item)=>item?`<div class="now-item"><div><small>${label} · ${esc(timeText(ev,item))}</small><strong>${esc(actNames(ev,item))}</strong></div><span class="act-type">${esc(item.type||'DJ')}</span></div>`:'';nowBox=`<section class="now-panel"><div class="now-top"><span><i class="live-dot"></i>NOW / NEXT</span><span>${esc(st.label)}</span></div>${line('NOW',st.current)}${line('NEXT',st.next)}${!st.current&&!st.next?'<p style="font-size:12px;color:#bbb;margin:12px 0 0">タイムテーブルを確認してみましょう。</p>':''}</section>`;}
    app.innerHTML=`${headerTitle('音楽と、今夜を楽しもう。','イベントの最新情報をチェック。次の出演者やドリンクメニューもここから。')}${hero}${nowBox}<div class="quick-grid"><button class="quick" data-goto="schedule"><span>▤</span>タイムテーブル</button><button class="quick" data-goto="drinks"><span>◉</span>ドリンク</button><button class="quick" data-goto="photos"><span>▧</span>フォト</button><button class="quick" data-goto="archive"><span>◷</span>過去のイベント</button></div><div class="section-head"><h2>次回の開催</h2><button data-goto="archive">すべて見る</button></div>${upcoming.length?`<div class="event-grid">${upcoming.slice(0,4).map(eventCard).join('')}</div>`:`<div class="empty"><strong>次回イベントは準備中</strong>開催情報が公開されるまでお待ちください。</div>`}<div class="section-head"><h2>イベントをシェア</h2></div><div class="card"><p style="font-size:13px;color:var(--sub);margin:0 0 12px">友達にもtonight!を共有しよう。</p><div class="btn-row"><button class="btn secondary" id="shareMain">イベントをシェア ↗</button><button class="btn secondary" id="noticeBtn">開催通知を設定</button></div><p class="notice" style="margin-bottom:0">通知はこのアプリを開いている間に、開催前のお知らせを表示します。</p></div><div class="footer">TONIGHT! · TSUKUBA MUSIC PROJECT</div>`;
  }
  function renderSchedule(){
    const ev=selected();if(!ev){app.innerHTML=headerTitle('タイムテーブル')+'<div class="empty"><strong>イベントがありません</strong>開催情報が公開されると、ここに表示されます。</div>';return;}
    const acts=actsFor(ev), st=statusFor(ev);
    const cards=acts.map(a=>{const r=actRange(ev,a),isNow=r.start&&r.end&&new Date()>=r.start&&new Date()<r.end;return `<button class="act ${isNow?'is-now':''}" data-act="${esc(a.id)}"><div class="act-time">${esc(timeText(ev,a))}<small>${esc(a.startDate&&a.startDate!==ev.date?a.startDate:'')}</small></div><div class="act-info"><span class="act-type">${esc(a.type==='その他'?(a.customType||'その他'):(a.type||'DJ'))}${isNow?' · NOW':''}</span><strong>${esc(actNames(ev,a))}</strong><p>出演者プロフィールを見る　›</p></div></button>`;}).join('');
    app.innerHTML=`${headerTitle('タイムテーブル',`${ev.name} · ${dateLabel(ev.date)}`)}<div class="event-meta">${statusPill(ev)}<span class="pill">${acts.length} STAGES / SETS</span></div>${acts.length?`<div class="timeline">${cards}</div>`:`<div class="empty"><strong>タイムテーブルは未公開です</strong>公開され次第、こちらに表示されます。</div>`}<p class="notice">出演時間は運営の更新により変更される場合があります。</p>`;
  }
  function renderDrinks(){
    const ev=selected();if(!ev){app.innerHTML=headerTitle('ドリンクメニュー')+'<div class="empty">イベントを選択してください。</div>';return;}
    const items=ev.products||[];
    app.innerHTML=`${headerTitle('ドリンクメニュー',`${ev.name} · 会場で販売予定の商品`)}${items.length?`<div class="drink-grid">${items.map(p=>`<div class="drink"><strong>${esc(p.name)}</strong><div class="price">${money(p.price)}</div>${p.soldOut?'<div class="sold">SOLD OUT</div>':''}</div>`).join('')}</div>`:`<div class="empty"><strong>メニューは準備中です</strong>公開され次第、こちらに表示されます。</div>`}<p class="notice">※価格・販売状況は当日の状況により変更される場合があります。</p>`;
  }
  function renderPhotos(){
    const ev=selected();if(!ev){app.innerHTML=headerTitle('フォトギャラリー')+'<div class="empty">イベントを選択してください。</div>';return;}
    const images=[...(ev.gallery||[])];if(flyerUrl(ev))images.unshift(flyerUrl(ev));
    app.innerHTML=`${headerTitle('フォトギャラリー',`${ev.name}のビジュアル`)}${images.length?`<div class="photo-grid">${images.map((src,i)=>`<img src="${esc(src)}" alt="${esc(ev.name)} 写真 ${i+1}" loading="lazy" data-photo="${esc(src)}">`).join('')}</div>`:`<div class="empty"><strong>写真はまだありません</strong>イベントの写真が公開されると、ここに追加されます。</div>`}<p class="notice">写真の追加・公開はイベント運営によって行われます。</p>`;
  }
  function renderArchive(){
    const archived=archivedEvents(), past=activeEvents().filter(e=>(e.date||'')<localDate(new Date())).reverse();
    app.innerHTML=`${headerTitle('イベントアーカイブ','これまでのtonight!を振り返ろう。')}<div class="section-head"><h2>過去のイベント</h2></div>${archived.length||past.length?`<div class="event-grid">${[...archived,...past.filter(p=>!archived.some(a=>a.id===p.id))].map(eventCard).join('')}</div>`:`<div class="empty"><strong>アーカイブはまだありません</strong>イベント終了後、公開されたイベントがこちらに並びます。</div>`}`;
  }
  function renderEventDetail(ev){
    const acts=actsFor(ev),isGoing=isRsvped(ev.id),image=flyerUrl(ev);
    app.innerHTML=`<button class="text-link" id="backHome">← イベント一覧へ</button>${image?`<img src="${image}" alt="${esc(ev.name)}" style="width:100%;max-height:55vh;object-fit:contain;border-radius:16px;background:#e9eaee;margin:12px 0">`:''}${headerTitle(ev.name,dateLabel(ev.date))}<div class="event-meta">${statusPill(ev)}${ev.venue?`<span class="pill">${esc(ev.venue)}</span>`:''}</div>${ev.description?`<div class="card"><p style="font-size:14px;line-height:1.7;margin:0">${esc(ev.description)}</p></div>`:''}<div class="card"><h2 style="font-size:17px;margin:0 0 12px">参加予定</h2><p style="font-size:12px;color:var(--sub);margin:0 0 12px">この端末に参加予定を保存します。主催者への参加登録や人数集計には送信されません。</p><button class="btn ${isGoing?'secondary':'blue'}" id="rsvpBtn">${isGoing?'✓ 参加予定に登録済み':'参加予定にする'}</button></div><div class="section-head"><h2>タイムテーブル</h2><button data-goto="schedule">すべて見る</button></div>${acts.length?`<div class="timeline">${acts.slice(0,5).map(a=>`<button class="act" data-act="${esc(a.id)}"><div class="act-time">${esc(timeText(ev,a))}</div><div class="act-info"><span class="act-type">${esc(a.type||'DJ')}</span><strong>${esc(actNames(ev,a))}</strong></div></button>`).join('')}</div>`:'<div class="empty">タイムテーブルは準備中です。</div>'}<div class="btn-row" style="margin-top:16px"><button class="btn secondary" id="eventShare">↗ シェア</button><button class="btn secondary" data-goto="photos">写真を見る</button></div>`;
  }
  function render(){
    const back=$('#backBtn'); back.hidden=page==='home';
    if(page==='detail'){const ev=data.events.find(e=>e.id===selectedId);if(ev)renderEventDetail(ev);else setPage('home');return;}
    ({home:renderHome,schedule:renderSchedule,drinks:renderDrinks,photos:renderPhotos,archive:renderArchive}[page]||renderHome)();
  }
  function openModal(html){modalRoot.innerHTML=`<div class="modal" data-dismiss="1"><div class="modal-box"><button class="modal-close" data-close aria-label="閉じる">×</button>${html}</div></div>`;}
  function openAct(id){const ev=selected();const act=actsFor(ev).find(a=>String(a.id)===String(id));if(!act)return;const names=actNames(ev,act),members=(ev.members||[]).filter(m=>(act.memberIds||[]).map(String).includes(String(m.id)));
    openModal(`<div class="eyebrow">${esc(act.type==='その他'?(act.customType||'OTHER'):(act.type||'DJ'))}</div><h2>${esc(names)}</h2><p>${esc(dateLabel(act.startDate||ev.date))} · ${esc(timeText(ev,act))}</p>${members.length?members.map(m=>`<div class="card" style="box-shadow:none;border:1px solid #eee;margin:12px 0"><strong>${esc(m.nickname||m.name)}</strong>${m.genre?`<p>GENRE · ${esc(m.genre)}</p>`:''}${m.bio?`<p>${esc(m.bio)}</p>`:''}${m.instagram?`<p>Instagram · ${esc(m.instagram)}</p>`:''}</div>`).join(''):`<p>出演者プロフィールはまだ登録されていません。</p>`}`);
  }
  async function share(){const ev=selected();const url=ev?`${location.origin}${location.pathname}#event=${encodeURIComponent(ev.id)}`:location.href;const title=ev?`tonight! | ${ev.name}`:'tonight! | TSUKUBA MUSIC PROJECT';const text=ev?`${ev.name} · ${dateLabel(ev.date)}`:'TSUKUBA MUSIC PROJECTのイベント情報';if(navigator.share){try{await navigator.share({title,text,url});}catch(e){if(e.name!=='AbortError')copyUrl(url);}}else copyUrl(url);}
  async function enableNotices(){
    if(!('Notification' in window)){alert('このブラウザは通知に対応していません。');return;}
    const permission=await Notification.requestPermission();
    if(permission==='granted'){localStorage.setItem(NOTICE_KEY,'1');alert('開催通知を設定しました。アプリを開いている間に開催前のお知らせを表示します。');checkReminders();}
    else alert('通知が許可されませんでした。ブラウザの設定から通知を許可できます。');
  }
  function checkReminders(){
    if(localStorage.getItem(NOTICE_KEY)!=='1'||!('Notification' in window)||Notification.permission!=='granted')return;
    const sent=(()=>{try{return JSON.parse(localStorage.getItem(NOTICE_KEY+'_sent')||'{}')}catch{return {}}})();
    const now=Date.now();
    for(const ev of activeEvents()){if(localDate(new Date(now))===ev.date&&!sent[ev.id]){new Notification('tonight!｜本日開催！',{body:`${ev.name} · ${dateLabel(ev.date)}`});sent[ev.id]=true;}}
    localStorage.setItem(NOTICE_KEY+'_sent',JSON.stringify(sent));
  }
  async function copyUrl(url){try{await navigator.clipboard.writeText(url);alert('リンクをコピーしました！');}catch{prompt('このリンクをコピーしてください',url);}}
  async function loadData(silent=false){
    try{const res=await fetch('/api/public/db',{cache:'no-store'});if(!res.ok)throw new Error(`HTTP ${res.status}`);const next=await res.json();data={events:Array.isArray(next.events)?next.events:[],updated:next.updated||0};
      if(!selectedId||!data.events.some(e=>e.id===selectedId))selectedId=chooseFeatured()?.id||data.events[0]?.id||null;
      if(!silent)render();
    }catch(error){if(!silent)app.innerHTML=`${headerTitle('情報を読み込めませんでした')}<div class="error">イベント情報の取得に失敗しました。通信環境を確認して、再読み込みしてください。<br><br><button class="btn" id="retry">再読み込み</button></div>`;}
  }
  document.addEventListener('click',e=>{
    const close=e.target.closest('[data-close]');if(close||e.target.matches('.modal[data-dismiss]')){modalRoot.innerHTML='';return;}
    const nav=e.target.closest('[data-page]');if(nav){setPage(nav.dataset.page);return;}
    const goto=e.target.closest('[data-goto]');if(goto){setPage(goto.dataset.goto);return;}
    const event=e.target.closest('[data-event]');if(event){selectedId=event.dataset.event;page='detail';render();window.scrollTo(0,0);return;}
    const act=e.target.closest('[data-act]');if(act){openAct(act.dataset.act);return;}
    const photo=e.target.closest('[data-photo]');if(photo){openModal(`<img src="${esc(photo.dataset.photo)}" alt="写真" style="width:100%;border-radius:12px">`);return;}
    if(e.target.closest('#shareBtn,#shareMain,#eventShare')){share();return;}
    if(e.target.closest('#noticeBtn')){enableNotices();return;}
    if(e.target.closest('#rsvpBtn')){const yes=!isRsvped(selectedId);saveRsvp(selectedId,yes);render();return;}
    if(e.target.closest('#backBtn,#backHome')){setPage('home');return;}
    if(e.target.closest('#retry'))loadData();
  });
  window.addEventListener('hashchange',()=>{const match=location.hash.match(/event=([^&]+)/);if(match){selectedId=decodeURIComponent(match[1]);if(data.events.some(e=>e.id===selectedId)){page='detail';render();}}});
  const hash=location.hash.match(/event=([^&]+)/);if(hash)selectedId=decodeURIComponent(hash[1]);
  loadData();refreshTimer=setInterval(()=>{loadData(true);checkReminders();},30000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)loadData(true);});
})();

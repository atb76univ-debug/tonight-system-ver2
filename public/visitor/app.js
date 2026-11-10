(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const app = $('#app'), modalRoot = $('#modalRoot');
  const RSVP_KEY = 'tonight_visitor_rsvp_v1';
  const NOTICE_KEY = 'tonight_visitor_notice_v1';
  let data = {events:[],updated:0}, selectedId = null, page = 'select', lastPage = 'home', profileFocusIds = null;
  const VISITOR_ID_KEY = 'tonight_visitor_id_v1';
  const visitorId = (() => { let id=localStorage.getItem(VISITOR_ID_KEY); if(!id){id=(crypto.randomUUID?crypto.randomUUID():`v_${Date.now()}_${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g,'');localStorage.setItem(VISITOR_ID_KEY,id);} return id; })();
  let refreshTimer = null;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = n => `¥${Number(n||0).toLocaleString('ja-JP')}`;
  const localDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const dateObj = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s||'')) ? new Date(`${s}T00:00:00`) : null;
  const dateLabel = s => { const d=dateObj(s); return d ? `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日（${'日月火水木金土'[d.getDay()]}）` : '日程未定'; };
  const rsvps = () => { try{return JSON.parse(localStorage.getItem(RSVP_KEY)||'{}')}catch{return {}} };
  const rsvpStatus = id => { const value=rsvps()[id]; return value===true?'going':(['going','interested','not-going'].includes(value)?value:null); };
  const hasResponded = id => Boolean(rsvpStatus(id));
  const saveRsvp = (id, value) => { const v=rsvps(); if(value)v[id]=value; else delete v[id]; localStorage.setItem(RSVP_KEY,JSON.stringify(v)); };
  const activeEvents = () => data.events.filter(e=>!e.archived).sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  const archivedEvents = () => data.events.filter(e=>e.archived).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const selected = () => selectedId ? (data.events.find(e=>e.id===selectedId) || null) : null;
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
  function isPublicPerformance(act){
    const raw=[act?.type,act?.customType,act?.name].filter(Boolean).join(' ').toLowerCase();
    return !/(準備|設営|撤収|リハーサル|リハ|サウンドチェック|sound\\s*check|setup|preparation|rehearsal|搬入|片付け)/i.test(raw);
  }
  function actsFor(ev){return (Array.isArray(ev?.acts)?ev.acts:[]).filter(isPublicPerformance).slice().sort((a,b)=>(actRange(ev,a).start?.getTime()||0)-(actRange(ev,b).start?.getTime()||0));}
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
  function updateHeaderNowNext(){
    const host=document.getElementById('headerNow');
    if(!host)return;
    const ev=selected();
    if(!ev||page==='select'){host.hidden=true;host.innerHTML='';return;}
    const st=statusFor(ev), current=st.current?.a||null, next=st.next?.a||null;
    const currentHtml=current?`<span class="header-now-current"><i class="live-dot"></i>NOW <b>${esc(actNames(ev,current))}</b></span>`:'';
    const nextHtml=next?`<span class="header-now-next"><i class="live-dot"></i>NEXT <b>${esc(actNames(ev,next))}</b></span>`:'';
    host.hidden=false;
    host.innerHTML=currentHtml+nextHtml||'<span class="header-now-soon">COMING SOON...</span>';
  }
  function renderEventSelect(){
    const upcoming=activeEvents();
    const next=upcoming.find(e=>(e.date||'')>=localDate(new Date())) || null;
    const nextEventCard=next
      ? `<section class="select-next-event"><span class="header-next-label"><i class="live-dot"></i>NEXT EVENT</span><strong>${esc(dateLabel(next.date))}</strong><span class="header-next-name">${esc(next.name)}</span></section>`
      : `<section class="select-next-event"><span class="header-next-label">NEXT EVENT</span><strong>次回開催は調整中</strong></section>`;
    app.innerHTML=`${nextEventCard}<div class="event-carousel" aria-label="イベント一覧">${upcoming.length?upcoming.map(ev=>`<button class="event-select-card" data-select-event="${esc(ev.id)}">${flyerUrl(ev)?`<img src="${flyerUrl(ev)}" alt="${esc(ev.name)} フライヤー">`:`<div class="event-select-placeholder"><img src="../TMPlogo.png" alt=""></div>`}<div class="event-select-copy"><div>${statusPill(ev)}</div><strong>${esc(ev.name)}</strong><small>${esc(dateLabel(ev.date))}${ev.venue?` · ${esc(ev.venue)}`:''}</small><span>イベントを開く　›</span></div></button>`).join(''):`<div class="empty"><strong>公開中のイベントはありません</strong>次回のtonight!をお楽しみに。</div>`}</div>${archivedEvents().length?`<div class="section-head"><h2>過去のイベント</h2><button data-page="archive">アーカイブを見る</button></div>`:''}<div class="footer">TONIGHT! · TSUKUBA MUSIC PROJECT</div>`;
  }
  function renderHome(){
    const ev=selected(); if(!ev){page='select';renderEventSelect();return;} const upcoming=activeEvents().filter(e=>(e.date||'')>=localDate(new Date()));
    const hero=ev?`<button class="hero-card" data-event="${esc(ev.id)}">${flyerUrl(ev)?`<img src="${flyerUrl(ev)}" alt="">`:''}<div class="hero-copy"><div class="eyebrow">${statusPill(ev)}</div><h2>${esc(ev.name)}</h2><p>${esc(dateLabel(ev.date))}${ev.venue?` · ${esc(ev.venue)}`:''}</p></div></button>`:`<div class="empty"><strong>イベント情報はまだありません</strong>次回のtonight!をお楽しみに。</div>`;
    let nowBox='';
    if(ev){const st=statusFor(ev);const line=(label,item)=>item?`<div class="now-item"><div><small>${label} · ${esc(timeText(ev,item))}</small><strong>${esc(actNames(ev,item))}</strong></div><span class="act-type">${esc(item.type||'DJ')}</span></div>`:'';nowBox=`<section class="now-panel"><div class="now-top"><span><i class="live-dot"></i>NOW / NEXT</span><span>${esc(st.label)}</span></div>${line('NOW',st.current)}${line('NEXT',st.next)}${!st.current&&!st.next?'<p style="font-size:12px;color:#bbb;margin:12px 0 0">タイムテーブルを確認してみましょう。</p>':''}</section>`;}
    app.innerHTML=`${headerTitle('音楽と、今夜を楽しもう。','イベントの最新情報をチェック。次の出演者やドリンクメニューもここから。')}<div class="selected-event-bar"><span>EVENT · ${esc(ev.name)}</span><button data-switch-event>イベントを変更</button></div>${hero}${nowBox}<div class="quick-grid"><button class="quick" data-goto="schedule"><span>▤</span>タイムテーブル</button><button class="quick" data-goto="drinks"><span>◉</span>ドリンク</button><button class="quick" data-goto="photos"><span>▧</span>フォト</button><button class="quick" data-goto="archive"><span>◷</span>過去のイベント</button></div><div class="section-head"><h2>次回の開催</h2><button data-goto="archive">すべて見る</button></div>${upcoming.length?`<div class="event-grid">${upcoming.slice(0,4).map(eventCard).join('')}</div>`:`<div class="empty"><strong>次回イベントは準備中</strong>開催情報が公開されるまでお待ちください。</div>`}<div class="section-head"><h2>イベントをシェア</h2></div><div class="card"><p style="font-size:13px;color:var(--sub);margin:0 0 12px">友達にもtonight!を共有しよう。</p><div class="btn-row"><button class="btn secondary" id="shareMain">イベントをシェア ↗</button><button class="btn secondary" id="noticeBtn">開催通知を設定</button></div><p class="notice" style="margin-bottom:0">通知はこのアプリを開いている間に、開催前のお知らせを表示します。</p></div><div class="footer">TONIGHT! · TSUKUBA MUSIC PROJECT</div>`;
  }
  function renderSchedule(){
    const ev=selected();if(!ev){app.innerHTML=headerTitle('タイムテーブル')+'<div class="empty"><strong>イベントがありません</strong>開催情報が公開されると、ここに表示されます。</div>';return;}
    const acts=actsFor(ev).filter(a=>{const r=actRange(ev,a);return Boolean(r.start&&r.end);}), st=statusFor(ev);
    const timeline=renderScheduleTimeline(ev,acts);
    const cards=acts.map(a=>{const r=actRange(ev,a),isNow=r.start&&r.end&&new Date()>=r.start&&new Date()<r.end;return `<button class="act ${isNow?'is-now':''}" data-act="${esc(a.id)}"><div class="act-time">${esc(timeText(ev,a))}<small>${esc(a.startDate&&a.startDate!==ev.date?a.startDate:'')}</small></div><div class="act-info"><span class="act-type">${esc(a.type==='その他'?(a.customType||'その他'):(a.type||'DJ'))}${isNow?' · NOW':''}</span><strong>${esc(actNames(ev,a))}</strong><p>出演者プロフィールを見る　›</p></div></button>`;}).join('');
    app.innerHTML=`${headerTitle('タイムテーブル',`${ev.name} · ${dateLabel(ev.date)}`)}<div class="event-meta">${statusPill(ev)}<span class="pill">${acts.length} STAGES / SETS</span></div>${acts.length?`<section class="timeline-visual-card"><div class="timeline-visual-heading"><strong>LIVE TIMELINE</strong><span>現在時刻に合わせて自動更新</span></div>${timeline}</section><div class="timeline-list-heading">出演スケジュール</div><div class="timeline">${cards}</div>`:`<div class="empty coming-soon"><strong>COMING SOON...</strong><span>タイムテーブルは近日公開予定です。</span></div>`}<p class="notice">出演時間は運営の更新により変更される場合があります。</p>`;
  }
  function renderScheduleTimeline(ev,acts){
    if(!acts.length)return '';
    const all=acts.map(a=>({a,...actRange(ev,a)})).filter(x=>x.start&&x.end).sort((a,b)=>a.start-b.start);
    if(!all.length)return '';
    const base=dateObj(ev.date)?.getTime()||all[0].start.getTime();
    const minute=d=>(d.getTime()-base)/60000;
    const starts=all.map(x=>minute(x.start)),ends=all.map(x=>minute(x.end));
    const now=minute(new Date()), min=Math.min(...starts,now>=Math.min(...starts)&&now<=Math.max(...ends)?Math.floor(now/60)*60:Math.min(...starts));
    const max=Math.max(...ends,min+60),span=Math.max(60,max-min);
    const laneEnds=[];const lanes=new Map();
    all.forEach(x=>{const st=minute(x.start),en=minute(x.end);let lane=laneEnds.findIndex(v=>v<=st);if(lane<0)lane=laneEnds.length;laneEnds[lane]=en;lanes.set(x.a.id,{lane,count:0});});
    all.forEach(x=>{const l=lanes.get(x.a.id);l.count=laneEnds.length;});
    const pxPerMinute=Math.max(1.1,...all.map(x=>58/Math.max(1,minute(x.end)-minute(x.start))));
    const height=Math.max(340,Math.ceil(span*pxPerMinute));
    const marker=(now-min)/span*100,showNow=now>=min&&now<=max;
    const blocks=all.map(x=>{
      const st=minute(x.start),en=minute(x.end),l=lanes.get(x.a.id),parallel=l.count>1;
      const left=parallel?`calc(12px + ${l.lane*100/l.count}%)`:'12px';
      const width=parallel?`calc(${100/l.count}% - 20px)`:'auto';
      const name=actNames(ev,x.a),type=x.a.type==='その他'?(x.a.customType||'その他'):(x.a.type||'DJ');
      return `<button class="visitor-timeline-block ${new Date()>=x.start&&new Date()<x.end?'is-live':''}" data-act="${esc(x.a.id)}" style="top:${(st-min)/span*100}%;height:${Math.max(2.5,(en-st)/span*100)}%;left:${left};${parallel?`width:${width};right:auto;`: 'right:12px;'}"><small>${esc(timeText(ev,x.a))}</small><strong>${esc(name)}</strong><span>${esc(type)}</span></button>`;
    }).join('');
    return `<div class="visitor-timeline-track" style="height:${height}px">${showNow?`<div class="visitor-timeline-now" style="top:${marker}%"><b>NOW</b></div>`:''}${blocks}</div>`;
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
  function renderNowNext(ev){
    const st=statusFor(ev);
    const line=(label,item)=>item?`<div class="now-item"><div><small>${label} · ${esc(timeText(ev,item))}</small><strong>${esc(actNames(ev,item))}</strong></div><span class="act-type">${esc(item.type||'DJ')}</span></div>`:'';
    const hasSchedule=actsFor(ev).length>0;
    return `<section class="now-panel"><div class="now-top"><span><i class="live-dot"></i>NOW / NEXT</span><span>${esc(st.label)}</span></div>${hasSchedule?(line('NOW',st.current)+line('NEXT',st.next)||'<p class="coming-soon-inline">COMING SOON...</p>'):'<p class="coming-soon-inline">COMING SOON...</p>'}</section>`;
  }
  function renderEventDetail(ev){
    const image=flyerUrl(ev), status=rsvpStatus(ev.id);
    const choice=(value,label,desc)=>`<button type="button" class="rsvp-choice ${status===value?'is-selected':''}" data-rsvp-choice="${value}"><strong>${label}</strong><small>${desc}</small></button>`;
    app.innerHTML=`${image?`<img src="${image}" alt="${esc(ev.name)}" class="detail-flyer">`:''}${headerTitle(ev.name,dateLabel(ev.date))}<div class="event-meta">${statusPill(ev)}${ev.venue?`<span class="pill">${esc(ev.venue)}</span>`:''}</div>${ev.description?`<div class="card"><p class="event-description">${esc(ev.description)}</p></div>`:''}<section class="card rsvp-gate"><div class="eyebrow">YOUR PLAN</div><h2 class="card-heading">今夜、会場で会いましょう。</h2><p class="rsvp-intro">参加予定をシェアして、みんなでイベントを楽しもう。</p><label class="rsvp-name-label" for="rsvpName">表示名（参加・興味ありの場合に公開）</label><input id="rsvpName" maxlength="30" placeholder="ニックネームを入力" value="${esc(localStorage.getItem('tonight_visitor_display_name')||'')}"><div class="rsvp-choice-grid">${choice('going','参加','行く予定！')}${choice('interested','興味あり','気になっている')}${choice('not-going','不参加','今回は参加しない')}</div><button class="btn secondary rsvp-cancel" id="rsvpCancel" ${status?'':'hidden'}>参加表明を取り消す</button><div class="rsvp-summary"><div id="rsvpCount" class="rsvp-count-grid"><span>読み込み中…</span></div><div id="rsvpParticipants" class="rsvp-participants"></div></div><div class="rsvp-actions"><button class="btn secondary" id="eventShare">↗ 友達にシェア</button><button class="btn secondary" id="calendarAdd">＋ カレンダーに追加</button><button class="btn secondary" id="noticeBtn">出演開始通知を設定</button></div><p class="rsvp-privacy">「参加」「興味あり」の名前のみ公開されます。不参加は人数・名前ともに公開されません。</p></section><div class="detail-shortcuts"><button class="quick" data-goto="schedule"><span>▤</span>タイムテーブル</button><button class="quick" data-goto="profiles"><span>♙</span>出演者</button><button class="quick" data-goto="drinks"><span>◉</span>ドリンク</button><button class="quick" data-goto="photos"><span>▧</span>フォト</button></div>`;
    refreshRsvpList(ev.id);
  }
  async function refreshRsvpList(eventId){
    const count=$('#rsvpCount'), list=$('#rsvpParticipants'); if(!count||!list)return;
    try{
      const res=await fetch(`/api/public/rsvp?eventId=${encodeURIComponent(eventId)}&visitorId=${encodeURIComponent(visitorId)}`,{cache:'no-store'});
      if(!res.ok)throw new Error('RSVP load failed');
      const payload=await res.json();
      if(['going','interested','not-going'].includes(payload.myStatus)){saveRsvp(eventId,payload.myStatus);document.querySelectorAll('[data-rsvp-choice]').forEach(button=>button.classList.toggle('is-selected',button.dataset.rsvpChoice===payload.myStatus));}
      else {saveRsvp(eventId,null);document.querySelectorAll('[data-rsvp-choice]').forEach(button=>button.classList.remove('is-selected'));}
      const cancel=$('#rsvpCancel');if(cancel)cancel.hidden=!payload.myStatus;
      const people=(payload.participants||[]).filter(p=>['going','interested'].includes(p.status));
      const counts={going:0,interested:0};people.forEach(p=>counts[p.status]++);
      count.innerHTML=`<div class="rsvp-count"><strong>${counts.going}</strong><span>参加</span></div><div class="rsvp-count"><strong>${counts.interested}</strong><span>興味あり</span></div>`;
      const labels={going:'参加',interested:'興味あり'};
      list.innerHTML=people.length?people.map(p=>`<div class="rsvp-person"><span class="rsvp-avatar">${esc((p.name||'?').trim().slice(0,1).toUpperCase())}</span><span class="rsvp-person-name">${esc(p.name)}</span><span class="rsvp-person-status status-${p.status}">${labels[p.status]}</span></div>`).join(''):'<span class="notice">参加・興味ありの人はまだいません。</span>';
    }catch{count.textContent='参加状況を取得できませんでした';list.innerHTML='';}
  }
  async function setRsvpStatus(status){
    const ev=selected();if(!ev||!['going','interested','not-going'].includes(status))return;
    const enteredName=$('#rsvpName')?.value.trim()||localStorage.getItem('tonight_visitor_display_name')||'';
    const name=enteredName||(status==='not-going'?'非公開':'');
    if(!name){alert('参加・興味ありの場合は、一覧に表示する名前を入力してください。');$('#rsvpName')?.focus();return;}
    try{
      const res=await fetch(`/api/public/rsvp?eventId=${encodeURIComponent(ev.id)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({visitorId,name,status})});
      if(!res.ok)throw new Error(await res.text());
      saveRsvp(ev.id,status);if(status!=='not-going')localStorage.setItem('tonight_visitor_display_name',name);render();
    }catch(error){alert('参加表明を保存できませんでした。通信環境を確認して、もう一度お試しください。');}
  }

  async function cancelRsvp(){
    const ev=selected();if(!ev)return;
    try{
      const res=await fetch(`/api/public/rsvp?eventId=${encodeURIComponent(ev.id)}&visitorId=${encodeURIComponent(visitorId)}`,{method:'DELETE'});
      if(!res.ok)throw new Error(await res.text());
      saveRsvp(ev.id,null);render();
    }catch{alert('参加表明を取り消せませんでした。通信環境を確認して、もう一度お試しください。');}
  }
  function render(){
    const back=$('#backBtn'), nav=$('.bottom-nav'), hasEvent=Boolean(selectedId);
    back.hidden=page==='home'||page==='select';
    nav.hidden=page==='select'||!hasEvent;
    if(page==='select'){renderEventSelect();updateHeaderNowNext();return;}
    if(!hasEvent||!selected()){page='select';renderEventSelect();updateHeaderNowNext();return;}
    if(page==='home'||page==='detail'){renderEventDetail(selected());updateHeaderNowNext();return;}
    ({schedule:renderSchedule,profiles:renderProfiles,drinks:renderDrinks,photos:renderPhotos,archive:renderArchive}[page]||renderEventDetail)(selected());
    updateHeaderNowNext();
  }
  function openModal(html){modalRoot.innerHTML=`<div class="modal" data-dismiss="1"><div class="modal-box"><button class="modal-close" data-close aria-label="閉じる">×</button>${html}</div></div>`;}
  function performersFor(ev){
    const ids=[...new Set(actsFor(ev).flatMap(a=>(Array.isArray(a.memberIds)?a.memberIds:[]).map(String)))];
    const members=(ev?.members||[]);
    return ids.map(id=>members.find(m=>String(m.id)===id)).filter(Boolean);
  }
  function renderProfiles(){
    const ev=selected(); if(!ev){app.innerHTML=headerTitle('出演者');return;}
    const all=performersFor(ev);
    const categories=['DJ','LIVE','VJ','その他'];
    const categoryFor=act=>{const t=String(act.type==='その他'?(act.customType||'その他'):(act.type||'DJ')).toUpperCase();if(t.includes('DJ'))return 'DJ';if(t.includes('LIVE')||t.includes('BAND')||t.includes('ライブ'))return 'LIVE';if(t.includes('VJ'))return 'VJ';return 'その他';};
    const renderCard=(m,category)=>{const slots=actsFor(ev).filter(a=>categoryFor(a)===category&&(a.memberIds||[]).map(String).includes(String(m.id))).map(a=>({a,range:actRange(ev,a)})).filter(x=>x.range.start&&x.range.end);return `<article class="performer-profile-card">
      <div class="performer-profile-cover">${m.photo?`<img src="${esc(m.photo)}" alt="${esc(m.nickname||m.name)}" loading="lazy">`:`<div class="performer-profile-placeholder">tonight!</div>`}</div>
      <div class="performer-profile-body">
        <h2>${esc(m.nickname||m.name||'出演者')}</h2>
        ${slots.length?`<div class="profile-line profile-set-times"><b>出演時間</b><span>${slots.map(x=>`${esc(timeText(ev,x.a))}`).join('<br>')}</span></div>`:''}
        ${m.bio?`<p class="performer-bio">${esc(m.bio)}</p>`:''}
        ${m.genre?`<div class="profile-line"><b>GENRE</b><span>${esc(m.genre)}</span></div>`:''}
        ${m.favoriteArtists?`<div class="profile-line"><b>FAVORITE ARTISTS</b><span>${esc(m.favoriteArtists)}</span></div>`:''}
        <div class="profile-links">${m.instagram?`<a href="${esc(/^https:\/\//i.test(m.instagram)?m.instagram:`https://www.instagram.com/${m.instagram.replace(/^@/,'')}/`)}" target="_blank" rel="noopener">Instagram ↗</a>`:''}${m.spotifyPlaylist?`<a href="${esc(m.spotifyPlaylist)}" target="_blank" rel="noopener">Spotify Playlist ↗</a>`:''}</div>
      </div></article>`;};
    const groups=categories.map(category=>{
      const ids=[...new Set(actsFor(ev).filter(a=>categoryFor(a)===category).flatMap(a=>(a.memberIds||[]).map(String)))];
      const members=ids.map(id=>all.find(m=>String(m.id)===id)).filter(Boolean);
      const filtered=profileFocusIds?.length?members.filter(m=>profileFocusIds.includes(String(m.id))):members;
      return filtered.length?`<section class="profile-category"><div class="section-head"><h2>${category}</h2><span class="pill">${filtered.length}</span></div><div class="performer-profile-grid">${filtered.map(m=>renderCard(m,category)).join('')}</div></section>`:'';
    }).join('');
    app.innerHTML=`${headerTitle('出演者','カテゴリーごとに出演者のプロフィールをチェック。')}<div class="profile-event-label">${esc(ev.name)} · ${esc(dateLabel(ev.date))}</div>${groups||`<div class="empty"><strong>出演者プロフィールはまだありません</strong>プロフィールが登録されると、ここに表示されます。</div>`}`;
    profileFocusIds=null;
  }
  function openAct(id){
    const ev=selected(), act=actsFor(ev).find(a=>String(a.id)===String(id)); if(!act)return;
    profileFocusIds=(act.memberIds||[]).map(String);
    setPage('profiles');
  }
  async function share(){const ev=selected();const url=ev?`${location.origin}${location.pathname}#event=${encodeURIComponent(ev.id)}`:location.href;const title=ev?`tonight! | ${ev.name}`:'tonight! | TSUKUBA MUSIC PROJECT';const text=ev?`${ev.name} · ${dateLabel(ev.date)}`:'TSUKUBA MUSIC PROJECTのイベント情報';if(navigator.share){try{await navigator.share({title,text,url});}catch(e){if(e.name!=='AbortError')copyUrl(url);}}else copyUrl(url);}
  function addToCalendar(){
    const ev=selected();if(!ev)return;
    const acts=actsFor(ev).map(a=>actRange(ev,a)).filter(r=>r.start&&r.end);
    const start=acts.length?new Date(Math.min(...acts.map(r=>r.start.getTime()))):dateObj(ev.date);
    if(!start)return;const end=acts.length?new Date(Math.max(...acts.map(r=>r.end.getTime()))):new Date(start.getTime()+2*60*60*1000);
    const stamp=d=>d.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
    const url=new URL('https://calendar.google.com/calendar/render');
    url.searchParams.set('action','TEMPLATE');url.searchParams.set('text',`tonight! | ${ev.name}`);
    url.searchParams.set('dates',`${stamp(start)}/${stamp(end)}`);
    url.searchParams.set('details',`${ev.name}\\n${dateLabel(ev.date)}\\n${location.href}`);
    if(ev.venue)url.searchParams.set('location',ev.venue);
    window.open(url.toString(),'_blank','noopener');
  }
  async function enableNotices(){
    if(!('Notification' in window)){alert('このブラウザは通知に対応していません。');return;}
    const permission=await Notification.requestPermission();
    if(permission==='granted'){
      localStorage.setItem(NOTICE_KEY,'1');
      const ev=selected(), current=ev?statusFor(ev).current?.a:null;
      if(ev)localStorage.setItem(`${NOTICE_KEY}_current_${ev.id}`,current?String(current.id):'');
      alert('出演開始通知を設定しました。アプリを開いている間、出演開始をお知らせします。');
      checkReminders();
    } else alert('通知が許可されませんでした。ブラウザの設定から通知を許可できます。');
  }
  function checkReminders(){
    if(localStorage.getItem(NOTICE_KEY)!=='1'||!('Notification' in window)||Notification.permission!=='granted')return;
    const sent=(()=>{try{return JSON.parse(localStorage.getItem(NOTICE_KEY+'_sent')||'{}')}catch{return {}}})();
    const now=Date.now();
    for(const ev of activeEvents()){if(localDate(new Date(now))===ev.date&&!sent[ev.id]){new Notification('tonight!｜本日開催！',{body:`${ev.name} · ${dateLabel(ev.date)}`});sent[ev.id]=true;}}
    localStorage.setItem(NOTICE_KEY+'_sent',JSON.stringify(sent));
  }
  function checkNowPlayingNotice(){
    if(localStorage.getItem(NOTICE_KEY)!=='1'||!('Notification' in window)||Notification.permission!=='granted')return;
    const ev=selected();if(!ev)return;
    const current=statusFor(ev).current?.a||null;
    const key=`${NOTICE_KEY}_current_${ev.id}`;
    const previous=localStorage.getItem(key);
    const currentId=current?String(current.id):'';
    if(previous!==null&&currentId&&previous!==currentId){
      new Notification('tonight!｜NOW PLAYING',{body:`${actNames(ev,current)} がプレイ中です。`});
    }
    localStorage.setItem(key,currentId);
  }
  async function copyUrl(url){try{await navigator.clipboard.writeText(url);alert('リンクをコピーしました！');}catch{prompt('このリンクをコピーしてください',url);}}
  async function loadData(silent=false){
    try{const res=await fetch('/api/public/db',{cache:'no-store'});if(!res.ok)throw new Error(`HTTP ${res.status}`);const next=await res.json();data={events:Array.isArray(next.events)?next.events:[],updated:next.updated||0};
      if(selectedId&&!data.events.some(e=>e.id===selectedId)){selectedId=null;page='select';}
      if(!silent)render();
    }catch(error){if(!silent)app.innerHTML=`${headerTitle('情報を読み込めませんでした')}<div class="error">イベント情報の取得に失敗しました。通信環境を確認して、再読み込みしてください。<br><br><button class="btn" id="retry">再読み込み</button></div>`;}
  }
  document.addEventListener('click',e=>{
    const close=e.target.closest('[data-close]');if(close||e.target.matches('.modal[data-dismiss]')){modalRoot.innerHTML='';return;}
    const nav=e.target.closest('[data-page]');if(nav){setPage(nav.dataset.page);return;}
    const selectEvent=e.target.closest('[data-select-event]');if(selectEvent){selectedId=selectEvent.dataset.selectEvent;page='home';render();window.scrollTo(0,0);return;}
    if(e.target.closest('[data-switch-event],#eventSwitchTop')){selectedId=null;setPage('select');return;}
    const goto=e.target.closest('[data-goto]');if(goto){setPage(goto.dataset.goto);return;}
    const event=e.target.closest('[data-event]');if(event){selectedId=event.dataset.event;page='home';render();window.scrollTo(0,0);return;}
    const act=e.target.closest('[data-act]');if(act){openAct(act.dataset.act);return;}
    const photo=e.target.closest('[data-photo]');if(photo){openModal(`<img src="${esc(photo.dataset.photo)}" alt="写真" style="width:100%;border-radius:12px">`);return;}
    if(e.target.closest('#shareBtn,#shareMain,#eventShare')){share();return;}
    if(e.target.closest('#noticeBtn')){enableNotices();return;}
    if(e.target.closest('#calendarAdd')){addToCalendar();return;}
    const rsvpChoice=e.target.closest('[data-rsvp-choice]');if(rsvpChoice){setRsvpStatus(rsvpChoice.dataset.rsvpChoice);return;}
    if(e.target.closest('#rsvpCancel')){cancelRsvp();return;}
    if(e.target.closest('#backBtn')){if(page==='detail'){setPage('home');return;}setPage('home');return;}
    if(e.target.closest('#backHome')){setPage('home');return;}
    if(e.target.closest('#eventSwitchInline')){selectedId=null;setPage('select');return;}
    if(e.target.closest('#retry'))loadData();
  });
  window.addEventListener('hashchange',()=>{const match=location.hash.match(/event=([^&]+)/);if(match){selectedId=decodeURIComponent(match[1]);if(data.events.some(e=>e.id===selectedId)){page='home';render();}}});
  const hash=location.hash.match(/event=([^&]+)/);if(hash){selectedId=decodeURIComponent(hash[1]);page='home';}
  loadData();refreshTimer=setInterval(()=>{loadData(true);checkReminders();checkNowPlayingNotice();updateHeaderNowNext();if(page==='schedule')renderSchedule();if(page==='home')refreshRsvpList(selectedId);},30000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)loadData(true);});
})();

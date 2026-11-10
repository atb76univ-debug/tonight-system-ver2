(function(){
  const dict = {
    "ホーム":"Home","タイムテーブル":"Schedule","出演者":"Performers","ドリンク":"Drinks","フォト":"Photos","アーカイブ":"Archive",
    "イベント選択":"Select Event","イベントを変更":"Change Event","イベントを選択":"Select an event","イベントホーム":"Event Home",
    "イベント情報を読み込んでいます…":"Loading event information…","イベントがありません":"No events available",
    "タイムテーブルは近日公開予定です。":"The schedule will be announced soon.",
    "出演スケジュール":"Performance Schedule","出演者プロフィールを見る　›":"View performer profile ›",
    "ドリンクメニュー":"Drinks Menu","メニューは準備中です":"Menu coming soon","フォトギャラリー":"Photo Gallery",
    "フォトはまだありません":"No photos yet","イベントアーカイブ":"Event Archive","過去のイベント":"Past Events",
    "イベントの写真が公開されると、こちらに追加されます。":"Event photos will appear here once published.",
    "イベントの最新情報をチェック。次の出演者やドリンクメニューもここから。":"Check the latest event updates, performers, and drinks here.",
    "イベントを変更":"Change Event","参加":"Going","興味あり":"Interested","不参加":"Not Going",
    "参加表明":"RSVP","参加する":"I'm Going","興味あり":"Interested","参加を取り消す":"Cancel RSVP",
     "現在出演者はいません":"No performers on stage right now",
    "その他":"Other","シフト":"Shift","受付":"Reception","出演":"Performance",
    "イベント一覧":"Events","イベントを追加":"Add Event","イベントを保存":"Save Event",
    "新規作成":"Create New","追加":"Add","登録":"Register","登録する":"Register",
    "公開":"Publish","非公開":"Unpublish","公開中":"Published","下書き":"Draft",
    "プロフィール":"Profile","プロフィール編集":"Edit Profile","出演者プロフィール":"Performer Profile",
    "写真":"Photo","画像":"Image","紹介文":"Bio","ジャンル":"Genre","好きな音楽・アーティスト":"Favorite Music & Artists",
    "ドリンク":"Drinks","商品":"Product","売り切れ":"Sold Out","販売中":"Available",
    "タイムテーブルを確認してみましょう。":"Check the schedule for upcoming performances.",
    "次回開催は調整中":"Next event to be announced",
    "開催情報が公開されると、ここに表示されます。":"Event information will appear here once published.",
    "イベントを選択してください。":"Please select an event.",
    "イベント運営によって行われます。":"Managed by event organizers.",
    "参加状況":"RSVP Status","参加表明する":"RSVP",
    "名前を入力":"Enter your name","メールアドレス":"Email Address",
    "電話番号":"Phone Number","保存しました":"Saved","更新しました":"Updated",
    "変更を保存":"Save Changes","変更を破棄":"Discard Changes",
    "読み込みに失敗しました":"Failed to load","通信に失敗しました":"Connection failed",
    "データがありません":"No data available","該当するデータがありません":"No matching data",
    "COMING SOON...":"COMING SOON...","LIVE":"LIVE","NOW":"NOW","NEXT":"NEXT",
    "開催前":"Before Event","開催中":"In Progress","終了":"Ended","開催予定":"Upcoming",
    "出演時間は運営の更新により変更される場合があります。":"Performance times may change.",
    "フォトの追加・公開はイベント運営によって行われます。":"Photos are managed by the event organizers.",
    "現在時刻に合わせて自動更新":"Updates automatically",
    "出演者未設定":"Performer TBD","担当未設定":"Unassigned",
    "接続中…":"Connecting…","保存":"Save","キャンセル":"Cancel","削除":"Delete","編集":"Edit",
    "イベント一覧":"Events","設定":"Settings","シフト":"Shift","縮小":"Compact","しまう":"Collapse",
    "イベント":"Event","名前":"Name","時間":"Time","日付":"Date","場所":"Venue","金額":"Price",
     "検索":"Search","閉じる":"Close","戻る":"Back","次へ":"Next","確認":"Confirm","更新":"Update",
    "売上":"Sales","会計":"Checkout","レジ":"Cash Register","在庫":"Inventory","集計":"Summary",
    "担当者":"Staff","スタッフ":"Staff","勤務":"Shift","開始":"Start","終了":"End",
    "開始時刻":"Start Time","終了時刻":"End Time","出演者を追加":"Add Performer",
    "シフトを追加":"Add Shift","シフト管理":"Shift Management","タイムテーブル管理":"Schedule Management",
    "イベント設定":"Event Settings","基本情報":"Basic Information","詳細":"Details",
    "未設定":"Not Set","未登録":"Not Registered","完了":"Complete","未完了":"Incomplete",
    "はい":"Yes","いいえ":"No","有効":"Enabled","無効":"Disabled",
    "現在の出演・シフトなし":"No active performances or shifts",
    "現在の出演者はいません":"No performers on stage right now",
    "イベントを削除":"Delete Event","本当に削除しますか？":"Are you sure you want to delete this?",
    "ファイルを選択":"Choose File","アップロード":"Upload","ダウンロード":"Download",
    "画像を選択":"Choose Image","プロフィール画像":"Profile Image",
    "読み込み中…":"Loading…","エラー":"Error","再試行":"Retry"
  };
  const replacements=Object.entries(dict).sort((a,b)=>b[0].length-a[0].length);
  function translateString(value){
    let out=value;
    for(const [ja,en] of replacements) out=out.split(ja).join(en);
    return out;
  }
  function apply(){
    const english=localStorage.getItem("tonight-language")==="en";
    document.documentElement.lang=english?"en":"ja";
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
    nodes.forEach(n=>{if(n.nodeValue.trim())n.nodeValue=english?translateString(n.nodeValue):restore(n.nodeValue);});
    document.querySelectorAll("[placeholder],[aria-label],[title]").forEach(el=>{
      ["placeholder","aria-label","title"].forEach(attr=>{
        const v=el.getAttribute(attr);if(!v)return;
        if(english){if(!el.dataset["ja"+attr])el.dataset["ja"+attr]=v;el.setAttribute(attr,translateString(el.dataset["ja"+attr]));}
        else if(el.dataset["ja"+attr])el.setAttribute(attr,el.dataset["ja"+attr]);
      });
    });
    const btn=document.getElementById("languageToggle");
    if(btn){btn.textContent=english?"日本語":"EN";btn.setAttribute("aria-label",english?"Switch to Japanese":"Switch to English");}
  }
  function restore(value){
    // Original Japanese text is retained per text node on first translation.
    return value;
  }
  window.setTonightLanguage=function(lang){localStorage.setItem("tonight-language",lang);location.reload();};
  document.addEventListener("click",e=>{if(e.target.closest("#languageToggle"))window.setTonightLanguage(localStorage.getItem("tonight-language")==="en"?"ja":"en");});
  document.addEventListener("DOMContentLoaded",()=>{
    const english=localStorage.getItem("tonight-language")==="en";
    if(english)apply();
    const observer=new MutationObserver(()=>{if(localStorage.getItem("tonight-language")==="en")apply();});
    observer.observe(document.body,{childList:true,subtree:true,characterData:true});
  });
})();
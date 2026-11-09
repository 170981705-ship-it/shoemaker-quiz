/* ============================================================
 * 模拟考试模块 exam.js
 * 与练习模式的关键区别：作答过程中不显示答案，交卷后统一判分
 * 数据存 localStorage，按题库 ID 隔离（进度互不污染）
 * 兼容老版 iOS Safari / 微信内置浏览器：不用 ES6、不用 lookbehind
 * ============================================================ */

var EX_LS = 'shoemaker_quiz_exam_v1';
var EX_VIEWS = ['home-view','quiz-view','result-view','wrong-view','bank-view',
                'exam-setup-view','exam-view','exam-result-view','exam-review-view'];

var EX = {
  active:false, paper:[], answers:{}, flags:{}, idx:0,
  startAt:0, durationMin:60, strictMulti:true, timer:null,
  bankId:'', specName:'', lastResult:null
};

/* ---------------- 存储 ---------------- */
function exReadAll(){try{return JSON.parse(localStorage.getItem(EX_LS))||{};}catch(e){return{};}}
function exWriteAll(o){try{localStorage.setItem(EX_LS,JSON.stringify(o));return true;}catch(e){return false;}}
function exBankKey(){return BankManager.getActiveId();}
function exBankData(){var a=exReadAll();return a[exBankKey()]||{draft:null,history:[]};}
function exSetBankData(d){var a=exReadAll();a[exBankKey()]=d;return exWriteAll(a);}
function exHasDraft(){
  var d=exBankData();
  return !!(d.draft&&d.draft.bankId===exBankKey()&&d.draft.paper&&d.draft.paper.length);
}
function exEntryBadge(){return exHasDraft()?'<span class="ex-badge">未完成</span>':'';}

/* ---------------- 视图 ---------------- */
function exShowView(id){
  // 统一用 inline display 控制，且清除 .hidden（.hidden 带 !important，残留会导致其他视图打不开）
  EX_VIEWS.forEach(function(v){
    var el=document.getElementById(v);if(!el)return;
    el.classList.remove('hidden');
    el.style.display=(v===id)?((v==='home-view')?'block':'flex'):'none';
  });
  try{window.scrollTo(0,0);}catch(e){}
}

/* ---------------- 组卷 ---------------- */
function exShuffle(a){
  for(var i=a.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1));var t=a[i];a[i]=a[j];a[j]=t;}
  return a;
}
/* 按题库实际题型比例分层随机抽题，顺序为 判断 -> 单选 -> 多选（贴近真卷） */
function exBuildPaper(count){
  var qs=QB();if(!qs||!qs.length)return[];
  var pools={judge:[],single:[],multi:[]};
  qs.forEach(function(q,i){if(pools[q.t])pools[q.t].push(i);});
  var keys=['judge','single','multi'];
  var target=count>0?Math.min(count,qs.length):qs.length;
  var want={judge:0,single:0,multi:0},remain=target;
  keys.forEach(function(k,i){
    if(i===keys.length-1){want[k]=Math.max(0,Math.min(remain,pools[k].length));remain-=want[k];}
    else{
      var n=Math.round(target*pools[k].length/qs.length);
      want[k]=Math.max(0,Math.min(n,pools[k].length,remain));remain-=want[k];
    }
  });
  var guard=0;
  while(remain>0&&guard++<1000){
    var grew=false;
    for(var z=0;z<keys.length&&remain>0;z++){
      var kk=keys[z];
      if(want[kk]<pools[kk].length){want[kk]++;remain--;grew=true;}
    }
    if(!grew)break;
  }
  var paper=[];
  keys.forEach(function(k){
    exShuffle(pools[k].slice()).slice(0,want[k]).forEach(function(qid){paper.push({qid:qid,t:k});});
  });
  return paper;
}

/* ---------------- 配置页 ---------------- */
function openExamSetup(){
  exBindSegs();
  exRenderSetup();
  exShowView('exam-setup-view');
}
function exBindSegs(){
  var ids=['ex-count-seg','ex-time-seg','ex-rule-seg'];
  for(var x=0;x<ids.length;x++){
    (function(id){
      var box=document.getElementById(id);
      if(!box||box.getAttribute('data-bound'))return;
      box.setAttribute('data-bound','1');
      var btns=box.querySelectorAll('button');
      for(var i=0;i<btns.length;i++){
        btns[i].addEventListener('click',function(){
          for(var j=0;j<btns.length;j++)btns[j].classList.remove('on');
          this.classList.add('on');
          exUpdateSetupNote();
        });
      }
    })(ids[x]);
  }
}
function exSegVal(id,def){
  var el=document.querySelector('#'+id+' button.on');
  return el?el.getAttribute('data-v'):def;
}
function exUpdateSetupNote(){
  var qs=QB()||[];
  var count=parseInt(exSegVal('ex-count-seg','100'),10);
  var real=count>0?Math.min(count,qs.length):qs.length;
  var dist={judge:0,single:0,multi:0};
  exBuildPaper(count).forEach(function(p){dist[p.t]++;});
  var el=document.getElementById('ex-count-note');
  if(el)el.textContent='共 '+real+' 题 · 判断 '+dist.judge+' / 单选 '+dist.single+' / 多选 '+dist.multi+'（按题库比例随机抽取）';
}
function exFmtDate(ts){
  var d=new Date(ts);
  function p(n){return n<10?'0'+n:''+n;}
  return (d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes());
}
function exFmtSec(s){
  s=Math.max(0,Math.round(s||0));
  var m=Math.floor(s/60),ss=s%60;
  return m>0?m+'分'+(ss<10?'0':'')+ss+'秒':ss+'秒';
}
function exRenderSetup(){
  var qs=QB()||[],bank=BankManager.getActiveBank();
  var sum=BankManager.summarize(qs);
  var bi=document.getElementById('ex-bank-info');
  if(bi)bi.innerHTML='<b>'+esc(bank?bank.name:'内置题库')+'</b> · 共 '+sum.total+
    ' 题（判断 '+sum.judge+' / 单选 '+sum.single+' / 多选 '+sum.multi+'）';

  /* 未完成的考试 */
  var box=document.getElementById('ex-resume-box'),d=exBankData();
  if(exHasDraft()){
    var dr=d.draft;
    var leftSec=Math.max(0,Math.floor((dr.startAt+dr.durationMin*60000-Date.now())/1000));
    var doneN=0,ak=Object.keys(dr.answers||{});
    for(var i=0;i<ak.length;i++)if(dr.answers[ak[i]])doneN++;
    box.innerHTML='<div class="ex-resume">'+
      '<div class="ex-resume-t">⏸ 有一场未完成的考试</div>'+
      '<div class="ex-resume-d">'+esc(dr.specName||'模拟考试')+' · 已答 '+doneN+'/'+dr.paper.length+' 题'+
        (leftSec>0?' · 剩余约 '+Math.ceil(leftSec/60)+' 分钟':' · 已到时')+'</div>'+
      '<div class="ex-resume-b"><button class="btn-main" onclick="exResumeExam()">继续考试</button>'+
      '<button class="btn-ghost" onclick="exDiscardDraft()">放弃</button></div></div>';
  }else if(box)box.innerHTML='';

  exUpdateSetupNote();

  /* 历史成绩 */
  var h=d.history||[],hb=document.getElementById('ex-history');
  if(!hb)return;
  if(!h.length){hb.innerHTML='<div class="ex-h-empty">暂无考试记录，考完会自动留档</div>';return;}
  var html='<div class="ex-card"><div class="ex-h">最近成绩（本题库）</div>';
  h.slice(0,5).forEach(function(r){
    html+='<div class="ex-h-row"><span class="ex-h-date">'+exFmtDate(r.date)+'</span>'+
      '<span class="ex-h-score '+(r.score>=60?'pass':'fail')+'">'+r.score+' 分</span>'+
      '<span class="ex-h-meta">'+r.right+'/'+r.total+' 题 · '+exFmtSec(r.sec)+'</span></div>';
  });
  html+='</div>';
  hb.innerHTML=html;
}
function exDiscardDraft(){
  if(!confirm('放弃这场未完成的考试？已作答内容不会保留。'))return;
  exClearDraft();exRenderSetup();
}

/* ---------------- 开考 / 续考 / 暂存 ---------------- */
function exStartFromSetup(){
  var count=parseInt(exSegVal('ex-count-seg','100'),10);
  var mins=parseInt(exSegVal('ex-time-seg','60'),10);
  var strict=exSegVal('ex-rule-seg','strict')!=='loose';
  var qs=QB()||[];
  if(!qs.length){alert('当前题库没有题目，请先导入题库');return;}
  if(exHasDraft()&&!confirm('将放弃上一场未完成的考试，确定重新开考吗？'))return;
  var paper=exBuildPaper(count);
  if(!paper.length){alert('组卷失败，请检查题库内容');return;}
  exClearDraft();
  EX={active:true,paper:paper,answers:{},flags:{},idx:0,startAt:Date.now(),
      durationMin:mins,strictMulti:strict,timer:null,bankId:exBankKey(),
      specName:paper.length+'题模拟卷',lastResult:null};
  exPersistDraft();
  exShowView('exam-view');
  exRenderQuestion();
  exStartTimer();
}
function exResumeExam(){
  var d=exBankData(),dr=d.draft;
  if(!dr||dr.bankId!==exBankKey()){alert('考试记录已失效');exClearDraft();exRenderSetup();return;}
  EX={active:true,paper:dr.paper,answers:dr.answers||{},flags:dr.flags||{},
      idx:Math.max(0,Math.min(dr.idx||0,dr.paper.length-1)),startAt:dr.startAt,
      durationMin:dr.durationMin,strictMulti:dr.strictMulti!==false,timer:null,
      bankId:dr.bankId,specName:dr.specName||'模拟考试',lastResult:null};
  exShowView('exam-view');exRenderQuestion();exStartTimer();
}
function exPersistDraft(){
  if(!EX.active)return;
  var d=exBankData();
  d.draft={paper:EX.paper,answers:EX.answers,flags:EX.flags,idx:EX.idx,
           startAt:EX.startAt,durationMin:EX.durationMin,strictMulti:EX.strictMulti,
           bankId:EX.bankId,specName:EX.specName};
  exSetBankData(d);
}
function exClearDraft(){var d=exBankData();d.draft=null;exSetBankData(d);}
function exExitExam(){
  if(EX.active){exStopTimer();EX.active=false;}
  goHome();
}

/* ---------------- 计时 ---------------- */
function exStopTimer(){if(EX.timer){clearInterval(EX.timer);EX.timer=null;}}
function exStartTimer(){exStopTimer();exTick();EX.timer=setInterval(exTick,1000);}
function exTick(){
  if(!EX.active)return;
  var end=EX.startAt+EX.durationMin*60000;
  var left=Math.max(0,Math.floor((end-Date.now())/1000));
  var el=document.getElementById('ex-timer');
  if(el){
    var m=Math.floor(left/60),s=left%60;
    el.textContent=(m<10?'0':'')+m+':'+(s<10?'0':'')+s;
    if(el.parentNode)el.parentNode.style.color=left<=300?'var(--err)':'var(--main)';
  }
  if(left<=0)exSubmitExam(true);
}

/* ---------------- 答题渲染（不显示答案） ---------------- */
function exQ(){return QB()[EX.paper[EX.idx].qid];}
function exRenderQuestion(){
  if(!EX.active)return;
  var item=EX.paper[EX.idx],q=exQ(),ua=EX.answers[item.qid]||'';
  var prog=document.getElementById('ex-prog');
  if(prog)prog.textContent='第 '+(EX.idx+1)+' / '+EX.paper.length+' 题';
  var bar=document.getElementById('ex-bar');
  if(bar)bar.style.width=((EX.idx+1)/EX.paper.length*100)+'%';
  var flagged=!!EX.flags[item.qid],fb=document.getElementById('ex-flag-btn');
  if(fb){fb.textContent=flagged?'★ 已标记':'☆ 标记';fb.style.color=flagged?'#e67e22':'';}

  var html='<div class="qtag">'+TYPE_NAME[q.t]+'题<span class="m">· 第 '+(EX.idx+1)+' 题'+(flagged?' · 已标记':'')+'</span></div>';
  html+='<div class="qtext">'+q.q+'</div>';
  if(q.t==='judge'){
    html+='<div class="tf-row">'+
      '<div class="tf-btn'+(ua==='√'?' selected':'')+'" data-v="√" onclick="exPickJudge(\'√\')"><span class="ico">✓</span>正确</div>'+
      '<div class="tf-btn'+(ua==='×'?' selected':'')+'" data-v="×" onclick="exPickJudge(\'×\')"><span class="ico">✗</span>错误</div>'+
      '</div>';
  }else{
    html+='<div class="opts">';
    var letters=q.t==='multi'?'ABCDE':'ABCD';
    for(var i=0;i<letters.length;i++){
      var L=letters[i];if(!q.o||!q.o[L])break;
      html+='<div class="opt'+(ua.indexOf(L)>=0?' selected':'')+'" data-l="'+L+'" onclick="'+
        (q.t==='multi'?'exPickMulti(this)':'exPickSingle(this)')+'">'+
        '<div class="ltr">'+L+'</div><div>'+q.o[L]+'</div></div>';
    }
    html+='</div>';
    if(q.t==='multi')html+='<div class="ex-multi-hint">多选题 · 可勾选多个选项，再次点击取消</div>';
  }
  html+='<div class="ex-noanswer">🔒 考试模式不显示答案，交卷后统一判分与回顾</div>';
  var body=document.getElementById('ex-qbody');
  if(body){body.innerHTML=html;body.scrollTop=0;}
  var pb=document.getElementById('ex-prev-btn');if(pb)pb.disabled=EX.idx===0;
  var nb=document.getElementById('ex-next-btn');if(nb)nb.textContent=(EX.idx===EX.paper.length-1)?'末题·交卷':'下一题';
  exUpdateAnswered();
}
function exUpdateAnswered(){
  var n=0;
  EX.paper.forEach(function(p){if(EX.answers[p.qid])n++;});
  var el=document.getElementById('ex-answered');
  if(el)el.textContent='已答 '+n+'/'+EX.paper.length;
}
function exRecord(val){
  EX.answers[EX.paper[EX.idx].qid]=val;
  exPersistDraft();exUpdateAnswered();
}
function exPickJudge(v){
  exRecord(v);
  var btns=document.querySelectorAll('#ex-qbody .tf-btn');
  for(var i=0;i<btns.length;i++)btns[i].classList.remove('selected');
  var t=document.querySelector('#ex-qbody .tf-btn[data-v="'+v+'"]');
  if(t)t.classList.add('selected');
}
function exPickSingle(el){
  exRecord(el.getAttribute('data-l'));
  var opts=document.querySelectorAll('#ex-qbody .opt');
  for(var i=0;i<opts.length;i++)opts[i].classList.remove('selected');
  el.classList.add('selected');
}
function exPickMulti(el){
  var ua=EX.answers[EX.paper[EX.idx].qid]||'';
  var arr=ua?ua.split(''):[];
  var L=el.getAttribute('data-l'),pos=arr.indexOf(L);
  if(pos>=0){arr.splice(pos,1);el.classList.remove('selected');}
  else{arr.push(L);el.classList.add('selected');}
  exRecord(arr.sort().join(''));
}
function exPrev(){if(EX.idx>0){EX.idx--;exPersistDraft();exRenderQuestion();}}
function exNext(){
  if(EX.idx<EX.paper.length-1){EX.idx++;exPersistDraft();exRenderQuestion();}
  else exConfirmSubmit();
}
function exToggleFlag(){
  var item=EX.paper[EX.idx];
  EX.flags[item.qid]=!EX.flags[item.qid];
  exPersistDraft();exRenderQuestion();
}

/* ---------------- 答题卡 ---------------- */
function exToggleSheet(forceClose){
  var m=document.getElementById('ex-sheet-mask');if(!m)return;
  if(forceClose){m.classList.remove('show');return;}
  var show=!m.classList.contains('show');
  if(show)m.classList.add('show');else m.classList.remove('show');
  if(show)exRenderSheet();
}
function exRenderSheet(){
  var html='',done=0,flag=0;
  EX.paper.forEach(function(p,i){
    var a=EX.answers[p.qid];if(a)done++;
    var cls=a?'done':'';
    if(EX.flags[p.qid]){cls+=' flagged';flag++;}
    if(i===EX.idx)cls+=' cur';
    html+='<div class="ex-cell '+cls+'" onclick="exGoto('+i+')">'+(i+1)+'</div>';
  });
  var g=document.getElementById('ex-sheet-grid');if(g)g.innerHTML=html;
  var st=document.getElementById('ex-sheet-stat');
  if(st)st.textContent='已答 '+done+' 题 · 未答 '+(EX.paper.length-done)+' 题 · 标记 '+flag+' 题';
}
function exGoto(i){
  if(i<0||i>=EX.paper.length)return;
  EX.idx=i;exPersistDraft();exRenderQuestion();exToggleSheet(true);
}

/* ---------------- 判分 / 交卷 ---------------- */
function exNorm(s){return String(s||'').toUpperCase().split('').sort().join('');}
function exIsSubset(ua,ans){
  var a=exNorm(ua);if(!a)return false;
  for(var i=0;i<a.length;i++)if(ans.indexOf(a.charAt(i))<0)return false;
  return true;
}
function exAnsDisplay(q,ans){
  if(!ans)return '未作答';
  if(q.t==='judge')return ans==='√'?'正确':'错误';
  if(!q.o)return ans;
  return ans.split('').map(function(L){return L+'.'+(q.o[L]||'?');}).join(' / ');
}
function exGrade(){
  if(EX.bankId!==exBankKey())return null;   // 题库被切换，成绩作废
  var byType={judge:{right:0,got:0,total:0},single:{right:0,got:0,total:0},multi:{right:0,got:0,total:0}};
  var got=0,half=0,rightQids=[],wrongQids=[];
  EX.paper.forEach(function(p){
    var q=QB()[p.qid];if(!q)return;
    var ua=EX.answers[p.qid]||'',sc=0;
    if(q.t==='multi'){
      if(exNorm(ua)===exNorm(q.a))sc=1;
      else if(!EX.strictMulti&&ua&&exIsSubset(ua,q.a))sc=0.5;
    }else if(ua===q.a)sc=1;
    got+=sc;
    byType[p.t].total++;byType[p.t].got+=sc;
    if(sc===1){byType[p.t].right++;rightQids.push(p.qid);}
    else{if(sc===0.5)half++;wrongQids.push(p.qid);}
  });
  var total=EX.paper.length,bank=BankManager.getActiveBank();
  return {
    score:total?Math.round(got/total*100):0,got:got,total:total,
    right:rightQids.length,half:half,byType:byType,
    rightQids:rightQids,wrongQids:wrongQids,
    answers:JSON.parse(JSON.stringify(EX.answers)),
    paper:JSON.parse(JSON.stringify(EX.paper)),
    sec:Math.max(0,Math.min(EX.durationMin*60,Math.round((Date.now()-EX.startAt)/1000))),
    strictMulti:EX.strictMulti,specName:EX.specName,
    bankName:bank?bank.name:'内置题库',date:Date.now()
  };
}
function exConfirmSubmit(){
  if(!EX.active)return;
  var n=0;EX.paper.forEach(function(p){if(!EX.answers[p.qid])n++;});
  if(!confirm(n>0?('还有 '+n+' 题未作答，确定交卷吗？'):'全部题目已作答，确定交卷吗？'))return;
  exSubmitExam(false);
}
function exSubmitExam(auto){
  if(!EX.active)return;
  exStopTimer();
  var r=exGrade();
  EX.active=false;
  if(!r){alert('题库已切换，本次考试记录失效');exClearDraft();goHome();return;}
  /* 错题同步进错题本（按题库隔离，与练习模式共用） */
  var s=loadState();
  if(!s.wrong)s.wrong={};
  r.rightQids.forEach(function(id){delete s.wrong[id];});
  r.wrongQids.forEach(function(id){s.wrong[id]=true;});
  saveState(s);
  /* 历史成绩留档 */
  var d=exBankData();
  d.history=d.history||[];
  d.history.unshift({date:r.date,score:r.score,right:r.right,total:r.total,sec:r.sec,specName:r.specName});
  d.history=d.history.slice(0,10);
  d.draft=null;
  exSetBankData(d);
  EX.lastResult=r;
  exRenderResult(r,auto);
  exShowView('exam-result-view');
}

/* ---------------- 成绩页 ---------------- */
function exRenderResult(r,auto){
  var pass=r.score>=60;
  var sc=document.getElementById('ex-score');
  if(sc){sc.textContent=r.score;sc.style.color=pass?'var(--ok)':'var(--err)';}
  var pb=document.getElementById('ex-pass');
  if(pb){pb.textContent=pass?'✅ 达到及格线（60分）':'❌ 未达及格线（60分）';pb.className='ex-pass '+(pass?'pass':'fail');}
  var meta=document.getElementById('ex-rs-meta');
  if(meta)meta.innerHTML=(auto?'⏰ 时间到，已自动交卷<br>':'')+
    r.bankName+' · '+r.specName+'<br>用时 '+exFmtSec(r.sec)+' · 共 '+r.total+' 题 · 得 '+r.got+' 分'+
    (r.half?'（含 '+r.half+' 题半分）':'')+'<br><span style="color:var(--sub)">考试错题已自动加入错题本</span>';
  var html='';
  [['judge','判断题'],['single','单选题'],['multi','多选题']].forEach(function(x){
    var b=r.byType[x[0]];if(!b||!b.total)return;
    var pct=Math.round(b.got/b.total*100);
    html+='<div class="ex-type-row"><span class="ex-type-name">'+x[1]+'</span>'+
      '<div class="ex-type-bar"><div style="width:'+pct+'%"></div></div>'+
      '<span class="ex-type-num">'+b.right+'/'+b.total+'</span></div>';
  });
  var box=document.getElementById('ex-rs-types');if(box)box.innerHTML=html;
}
function exShowReview(){
  var r=EX.lastResult;
  if(!r){alert('暂无可回顾的试卷');return;}
  var qs=QB(),html='';
  r.paper.forEach(function(p,i){
    var q=qs[p.qid];if(!q)return;
    var ua=r.answers[p.qid]||'';
    var ok=exNorm(ua)===exNorm(q.a);
    var half=!ok&&q.t==='multi'&&!r.strictMulti&&ua&&exIsSubset(ua,q.a);
    var cls=ok?'ok':(half?'half':'bad');
    var badge=ok?'✓ 正确':(half?'◐ 半分':'✗ 错误');
    var optsHtml='';
    if(q.o){
      optsHtml='<div class="ex-rv-opts">';
      Object.keys(q.o).sort().forEach(function(L){
        var isAns=q.a.indexOf(L)>=0;
        optsHtml+='<div class="ex-rv-opt'+(isAns?' right':'')+'">'+L+'. '+q.o[L]+'</div>';
      });
      optsHtml+='</div>';
    }
    var tip='';try{tip=genTip(q)||'';}catch(e){tip='';}
    html+='<div class="ex-rv-item '+cls+'">'+
      '<div class="ex-rv-h"><span>第 '+(i+1)+' 题 · '+TYPE_NAME[q.t]+'题 · '+(q.m||'综合')+'</span>'+
      '<span class="ex-rv-badge">'+badge+'</span></div>'+
      '<div class="ex-rv-q">'+esc(q.q)+'</div>'+optsHtml+
      '<div class="ex-rv-ans">我的答案：<b>'+esc(exAnsDisplay(q,ua))+'</b><br>正确答案：<b>'+esc(exAnsDisplay(q,q.a))+'</b></div>'+
      (tip?'<div class="tip">'+tip+'</div>':'')+'</div>';
  });
  var list=document.getElementById('ex-review-list');if(list)list.innerHTML=html;
  exShowView('exam-review-view');
}
function exBackToResult(){exShowView('exam-result-view');}
function exBackToSetup(){exRenderSetup();exShowView('exam-setup-view');}
function exRetryWrong(){
  exShowView('home-view');
  startQuiz('wrong','wrong');
}

/* ---------------- 全局暴露（供 inline onclick 调用） ---------------- */
window.openExamSetup=openExamSetup;
window.exStartFromSetup=exStartFromSetup;
window.exResumeExam=exResumeExam;
window.exDiscardDraft=exDiscardDraft;
window.exExitExam=exExitExam;
window.exPickJudge=exPickJudge;
window.exPickSingle=exPickSingle;
window.exPickMulti=exPickMulti;
window.exPrev=exPrev;
window.exNext=exNext;
window.exToggleFlag=exToggleFlag;
window.exToggleSheet=exToggleSheet;
window.exGoto=exGoto;
window.exConfirmSubmit=exConfirmSubmit;
window.exShowReview=exShowReview;
window.exBackToResult=exBackToResult;
window.exBackToSetup=exBackToSetup;
window.exRetryWrong=exRetryWrong;
window.exEntryBadge=exEntryBadge;

const MODEL_VERSION = "setup-alerts-v5-sniper-only-long-trade";

const DEFAULT_CONFIG = {
  minPaperScore: 88,
  minUltraScore: 84,
  minEntryQuality: 80,
  minSetupQuality: 78,
  maxExitPressure: 45,
  cooldownMinutes: 180,
  maxAlertsPerRun: 2,
  maxAlertsPerDay: 5,
  blockMediumNews: true,
  blockHighNews: true,
  blockFtmoLocked: true,
  allowedSetups: ["trend-pullback","liquidity-rejection","breakout-continuation"]
};

export async function onRequestGet(c){return handle(c)}
export async function onRequestPost(c){return handle(c)}

async function handle(context){
  const env=context.env||{};
  const db=env.DB;
  if(!db)return json({ok:false,error:"DB missing"},500);

  await db.prepare(`
  CREATE TABLE IF NOT EXISTS setup_alerts(
    id TEXT PRIMARY KEY,
    created_at TEXT,
    pair TEXT,
    timeframe TEXT,
    direction TEXT,
    paper_score REAL,
    ultra_score REAL,
    entry_quality_score REAL,
    setup_type TEXT,
    reason TEXT
  )`).run();

  const url=new URL(context.request.url);
  const tf=(url.searchParams.get("timeframes")||"M15,H1").split(",");

  let candidates=[];
  for(const t of tf){
    const r=await fetch(`${url.origin}/api/paper-run?timeframe=${t}&dryRun=1`);
    const d=await r.json();
    if(d.topCandidates) candidates.push(...d.topCandidates);
  }

  const ranked=candidates
    .map(n)
    .filter(x=>x.signal==="BUY"||x.signal==="SELL")
    .filter(x=>x.paperScore>=DEFAULT_CONFIG.minPaperScore)
    .filter(x=>x.ultraScore>=DEFAULT_CONFIG.minUltraScore)
    .filter(x=>x.entryQualityScore>=DEFAULT_CONFIG.minEntryQuality)
    .filter(x=>x.setupQualityScore>=DEFAULT_CONFIG.minSetupQuality)
    .filter(x=>x.exitPressureScore<=DEFAULT_CONFIG.maxExitPressure)
    .filter(x=>DEFAULT_CONFIG.allowedSetups.includes(x.setupType))
    .filter(x=>!isFtmoLocked(x))
    .filter(x=>!isBadNews(x))
    .sort((a,b)=>score(b)-score(a));

  const selected=ranked.slice(0,DEFAULT_CONFIG.maxAlertsPerRun);

  const sent=[];
  for(const c of selected){
    const msg=buildMsg(c);
    const res=await send(env,msg);
    await db.prepare(`
      INSERT INTO setup_alerts VALUES(?,?,?,?,?,?,?,?,?,?)
    `).bind(
      id(),
      new Date().toISOString(),
      c.pair,
      c.timeframe,
      c.direction,
      c.paperScore,
      c.ultraScore,
      c.entryQualityScore,
      c.setupType,
      "sniper"
    ).run();

    sent.push({pair:c.pair,ok:res.ok});
  }

  return json({
    ok:true,
    version:MODEL_VERSION,
    scanned:candidates.length,
    selected:selected.length,
    sent
  });
}

/* ================= CORE ================= */

function n(c){
  return {
    pair:c.pair,
    timeframe:c.timeframe,
    direction:c.direction,
    signal:c.signal,
    paperScore:+c.paperScore||0,
    ultraScore:+c.ultraScore||0,
    entryQualityScore:+c.entryQualityScore||0,
    setupQualityScore:+c.setupQualityScore||0,
    exitPressureScore:+c.exitPressureScore||99,
    setupType:c.setupType||"",
    newsRiskLevel:c.newsRiskLevel||"",
    ftmoStatus:c.ftmoStatus||"",
    current:c.current,
    stopLoss:c.stopLoss,
    takeProfit:c.takeProfit,
    tp1:c.tp1,
    rr:c.rr
  }
}

function score(c){
  let s=0;
  s+=c.paperScore*0.3;
  s+=c.ultraScore*0.2;
  s+=c.entryQualityScore*0.2;
  s+=c.setupQualityScore*0.15;
  s+=(100-c.exitPressureScore)*0.1;

  if(c.setupType==="trend-pullback")s+=4;
  if(c.setupType==="liquidity-rejection")s+=2;

  return s;
}

function isFtmoLocked(c){
  return String(c.ftmoStatus).includes("LOCKED");
}

function isBadNews(c){
  const n=String(c.newsRiskLevel).toUpperCase();
  if(DEFAULT_CONFIG.blockHighNews && n==="HIGH")return true;
  if(DEFAULT_CONFIG.blockMediumNews && n==="MEDIUM")return true;
  return false;
}

/* ================= TELEGRAM ================= */

async function send(env,text){
  if(!env.TELEGRAM_BOT_TOKEN)return{ok:false};

  try{
    const r=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        chat_id:env.TELEGRAM_CHAT_ID,
        text,
        parse_mode:"HTML"
      })
    });
    return {ok:r.ok};
  }catch{
    return {ok:false};
  }
}

function buildMsg(c){
  const icon=c.direction==="buy"?"🟢":"🔴";
  return `${icon} <b>${c.pair} ${c.direction.toUpperCase()}</b> ${c.timeframe}

Score: ${Math.round(score(c))}
Paper: ${c.paperScore} | Ultra: ${c.ultraScore}
Entry: ${c.entryQualityScore}

Entry: ${c.current}
SL: ${c.stopLoss}
TP: ${c.takeProfit}
RR: ${c.rr}

Setup: ${c.setupType}

Mode: SNIPER`;
}

/* ================= UTILS ================= */

function id(){
  return "a_"+Date.now()+Math.random().toString(36).slice(2,6);
}

function json(d,s=200){
  return new Response(JSON.stringify(d),{
    status:s,
    headers:{"Content-Type":"application/json"}
  });
}

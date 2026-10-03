'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const PAGE = 1000;
const META = 'stock_metadata';

function nums(a) { return a.map(Number).filter(Number.isFinite); }
function sma(a,p){ if(a.length<p)return null; return a.slice(-p).reduce((x,y)=>x+y,0)/p; }
function ema(a,p){ if(a.length<p)return null; let e=a.slice(0,p).reduce((x,y)=>x+y,0)/p; const k=2/(p+1); for(let i=p;i<a.length;i++)e=(a[i]-e)*k+e; return e; }
function wma(a,p){ if(a.length<p)return null; const x=a.slice(-p); const d=p*(p+1)/2; return x.reduce((s,v,i)=>s+v*(i+1),0)/d; }
function rsi(a,p=14){ if(a.length<p+1)return null; let g=0,l=0; for(let i=1;i<=p;i++){const d=a[i]-a[i-1]; if(d>=0)g+=d;else l-=d;} let ag=g/p,al=l/p; for(let i=p+1;i<a.length;i++){const d=a[i]-a[i-1];const gg=d>0?d:0,ll=d<0?-d:0;ag=(ag*(p-1)+gg)/p;al=(al*(p-1)+ll)/p;} if(al===0)return 100; return 100-100/(1+ag/al); }
function macd(a){ const fast=ema(a,12), slow=ema(a,26); if(fast==null||slow==null)return null; const macdSeries=[]; let ef=null,es=null; for(let i=0;i<a.length;i++){if(i===11)ef=a.slice(0,12).reduce((x,y)=>x+y,0)/12; else if(i>11)ef=(a[i]-ef)*(2/13)+ef; if(i===25)es=a.slice(0,26).reduce((x,y)=>x+y,0)/26; else if(i>25)es=(a[i]-es)*(2/27)+es; if(i>=25)macdSeries.push(ef-es);} if(macdSeries.length<9)return null; const sig=ema(macdSeries,9); return {macd:macdSeries.at(-1),signal:sig,histogram:macdSeries.at(-1)-sig}; }
function boll(a,p=20,m=2){ if(a.length<p)return null; const x=a.slice(-p), mid=x.reduce((s,v)=>s+v,0)/p; const sd=Math.sqrt(x.reduce((s,v)=>s+(v-mid)**2,0)/p); return {middle:mid,upper:mid+m*sd,lower:mid-m*sd}; }
function atr(rows,p=14){ if(rows.length<p+1)return null; const tr=[]; for(let i=1;i<rows.length;i++){const h=rows[i].high,l=rows[i].low,pc=rows[i-1].ltp;tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));} let v=tr.slice(0,p).reduce((s,x)=>s+x,0)/p; for(let i=p;i<tr.length;i++)v=(v*(p-1)+tr[i])/p; return v; }
function psar(rows,step=.02,max=.2){ if(rows.length<2)return null; let trend=1,af=step,ep=rows[0].high,sar=rows[0].low; for(let i=1;i<rows.length;i++){const r=rows[i]; let ns=sar+af*(ep-sar); if(trend===1){if(i>=2)ns=Math.min(ns,rows[i-1].low,rows[i-2].low);else ns=Math.min(ns,rows[i-1].low); if(r.low<ns){trend=-1;ns=ep;ep=r.low;af=step;}else if(r.high>ep){ep=r.high;af=Math.min(max,af+step);}}else{if(i>=2)ns=Math.max(ns,rows[i-1].high,rows[i-2].high);else ns=Math.max(ns,rows[i-1].high); if(r.high>ns){trend=1;ns=ep;ep=r.high;af=step;}else if(r.low<ep){ep=r.low;af=Math.min(max,af+step);}} sar=ns;} return {value:sar,trend:trend===1?'up':'down'}; }
function stochastic(rows,p=14){if(rows.length<p)return null;const x=rows.slice(-p), hi=Math.max(...x.map(r=>r.high)),lo=Math.min(...x.map(r=>r.low));return hi===lo?50:((x.at(-1).ltp-lo)/(hi-lo))*100;}
function aroon(rows,p=25){if(rows.length<p)return null;const x=rows.slice(-p), hs=x.map(r=>r.high),ls=x.map(r=>r.low);const hi=hs.lastIndexOf(Math.max(...hs)),li=ls.lastIndexOf(Math.min(...ls));return {up:100*(p-1-hi)/(p-1),down:100*(p-1-li)/(p-1)};}
function mfi(rows,p=14){if(rows.length<p+1)return null;let pos=0,neg=0;for(let i=rows.length-p;i<rows.length;i++){const tp=(rows[i].high+rows[i].low+rows[i].ltp)/3, pp=(rows[i-1].high+rows[i-1].low+rows[i-1].ltp)/3, mf=tp*(rows[i].volume||0);if(tp>pp)pos+=mf;else if(tp<pp)neg+=mf;}if(neg===0)return 100;return 100-100/(1+pos/neg);}
function ichimoku(rows){if(rows.length<52)return null;const x=rows.slice(-52), mid=(a,b)=>{const h=Math.max(...x.slice(-b).map(r=>r.high)),l=Math.min(...x.slice(-b).map(r=>r.low));return(h+l)/2;};const ten=(Math.max(...x.slice(-9).map(r=>r.high))+Math.min(...x.slice(-9).map(r=>r.low)))/2;const kij=mid(x,26);const spanB=mid(x,52);return {tenkan:ten,kijun:kij,senkouA:(ten+kij)/2,senkouB:spanB};}
function linearRegression(a,p=20){if(a.length<p)return null;const y=a.slice(-p),n=p,sx=n*(n-1)/2,sxx=(n-1)*n*(2*n-1)/6,sy=y.reduce((s,v)=>s+v,0),sxy=y.reduce((s,v,i)=>s+i*v,0),den=n*sxx-sx*sx;if(!den)return null;const slope=(n*sxy-sx*sy)/den,inter=(sy-slope*sx)/n;return {slope,intercept:inter,value:slope*(n-1)+inter};}
function vwap(rows){let pv=0,v=0;for(const r of rows){const vol=r.volume||0;pv+=((r.high+r.low+r.ltp)/3)*vol;v+=vol;}return v?pv/v:null;}

async function fetchHistory(){const all=[];for(let from=0;;from+=PAGE){const {data,error}=await supabase.from('history_dse').select('ticker,date,ltp,high,low,volume').order('ticker',{ascending:true}).order('date',{ascending:true}).range(from,from+PAGE-1);if(error)throw error;if(!data?.length)break;all.push(...data);console.log(`📥 history rows: ${all.length}`);if(data.length<PAGE)break;}return all;}

async function main(){
 console.log('======================================'); console.log('📊 STOCKPULSE INDICATOR PRECOMPUTE'); console.log('======================================');
 const raw=await fetchHistory(); const groups=new Map();
 for(const r of raw){const ticker=String(r.ticker||'').trim();const ltp=Number(r.ltp);if(!ticker||!Number.isFinite(ltp)||ltp<=0)continue;const row={ticker,date:r.date,ltp,high:Number(r.high)||ltp,low:Number(r.low)||ltp,volume:Number(r.volume)||0};if(!groups.has(ticker))groups.set(ticker,[]);groups.get(ticker).push(row);}
 console.log(`📈 Calculating ${groups.size} tickers...`);
 let ok=0,skip=0,fail=0;
 for(const [ticker,rows] of groups){
   if(rows.length<60){skip++;continue;}
   const close=rows.map(r=>r.ltp);
   const ps=psar(rows), bb=boll(close), mc=macd(close), ar=aroon(rows), ic=ichimoku(rows);
   const indicators={
     rsi14:rsi(close,14), psar:ps?.value??null, psarTrend:ps?.trend??null,
     sma5:sma(close,5),sma10:sma(close,10),sma20:sma(close,20),sma50:sma(close,50),
     ema5:ema(close,5),ema10:ema(close,10),ema20:ema(close,20),ema50:ema(close,50),
     wma14:wma(close,14), atr14:atr(rows,14), stochastic14:stochastic(rows,14),
     macd:mc?.macd??null,macdSignal:mc?.signal??null,macdHistogram:mc?.histogram??null,
     bollinger:bb, aroon:ar, ichimoku:ic, mfi14:mfi(rows,14), vwap:vwap(rows),
     linearRegression20:linearRegression(close,20), calculatedFromDate:rows[0].date, calculatedToDate:rows.at(-1).date,
     calculationVersion:1
   };
   const calculatedAt=new Date().toISOString();
   // stock_metadata.rsi is a NUMERIC column; keep the rich RSI metadata inside indicators JSONB.
   const payload={indicators,last_updated:calculatedAt,rsi:indicators.rsi14,psar:indicators.psar};
   try{
     const {data:existing,error:e1}=await supabase.from(META).select('ticker').eq('ticker',ticker).maybeSingle(); if(e1)throw e1;
     if(existing){const {error}=await supabase.from(META).update(payload).eq('ticker',ticker);if(error)throw error;} else {const {error}=await supabase.from(META).insert({ticker,...payload});if(error)throw error;}
     ok++;
   }catch(e){fail++;console.error(`❌ ${ticker}:`,e.message||e);}
 }
 console.log(`🎉 Done. updated=${ok}, skipped=${skip}, failed=${fail}`); if(fail)process.exitCode=1;
}
main().catch(e=>{console.error('❌ PRECOMPUTE FAILED',e);process.exit(1);});

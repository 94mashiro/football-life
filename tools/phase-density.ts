// 测每阶段（青年/中段/晚年）故事事件触发数与够格池大小——确认稀疏窗口结构
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { setPoolProbeHooks } from "../src/engine/events";
import { randomSeed } from "../src/meta/legacy";
import type { GameState, Choice, } from "../src/engine/types";
import type { Position } from "../src/engine/data";



const SETUPS: {pos:Position;league:string;nation:string}[] = [
  {pos:"ST",league:"brasileirao",nation:"bra"},{pos:"GK",league:"premier-league",nation:"eng"},
  {pos:"CM",league:"laliga",nation:"esp"},{pos:"CB",league:"serie-a",nation:"cro"},
  {pos:"ST",league:"csl",nation:"chn"},{pos:"LW",league:"ligue-1",nation:"sen"},
  {pos:"RW",league:"eredivisie",nation:"ned"},{pos:"CDM",league:"bundesliga",nation:"ger"},
];
let _s=0x9e3779b9; function rnext(){_s^=_s<<13;_s>>>=0;_s^=_s>>17;_s^=_s<<5;_s>>>=0;return _s;}
const rint=(lo:number,hi:number)=>lo+Math.floor((rnext()/4294967296)*(hi-lo+1));
function hash32(s:string){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}

// 每次抽取记录 (age, eligibleCount)
const eligByPhase: Record<string, number[]> = {youth:[], mid:[], twilight:[]};
setPoolProbeHooks(null, (keys, age, storyOnly) => {
  if (!storyOnly) return;
  const ph = age<=19?"youth":age>=30?"twilight":"mid";
  eligByPhase[ph].push(keys.length);
});

const PER=4000;
for(let si=0;si<SETUPS.length;si++)for(let i=0;i<PER;i++){
  const seed=randomSeed(); _s=0x9e3779b9^hash32(seed)^(si*2654435761);
  const rs:RunSetup={seed,nationalityId:SETUPS[si]!.nation,position:SETUPS[si]!.pos,leagueId:SETUPS[si]!.league,blessings:[],ascension:0,pace:"normal"};
  let g:GameState=simulatePeriod(createRun(rs)); let guard=0;
  while(g.phase==="playing"&&guard++<400){
    if(g.pendingMilestone)g={...g,pendingMilestone:undefined};
    if(g.pendingChoice){const ch=g.pendingChoice.choices;const pick:Choice=ch.length>1?ch[rint(0,ch.length-1)]!:ch[0]!;g=resolveChoice(g,pick);if(g.phase==="playing"&&!g.pendingChoice)g=simulatePeriod(g);}
    else g=simulatePeriod(g);
  }
}
setPoolProbeHooks(null,null);
const avg=(a:number[])=>a.reduce((s,v)=>s+v,0)/(a.length||1);
console.log("每次 story 抽取时，够格事件数（按阶段）:");
for(const ph of ["youth","mid","twilight"]){
  const a=eligByPhase[ph]; if(!a.length)continue;
  a.sort((x,y)=>x-y);
  console.log(`  ${ph.padEnd(8)}: n=${a.length} 抽取 · 均值${avg(a).toFixed(1)} · 中位${a[Math.floor(a.length/2)]} · 区间${a[0]}–${a[a.length-1]}`);
}

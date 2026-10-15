// The care roster and everything worked out from it: who has the children
// each day, school days, where they sleep and each day's plans. Shared by the
// page (as window.ROSTER) and the server (for the calendar feed).
(function (root) {
"use strict";
var DAY=86400000;
// The agreed roster (care arrangement, Oct 2026 - Sep 2027).
// PHASES: from each start Friday, weekends alternate, with "a" having the
// weekend that begins on aFri. aFri null means no weekends are set.
var PHASES=[
  {start:"2026-09-04",aFri:"2026-09-04"},
  {start:"2026-12-18",aFri:null},          // Christmas and summer break: not on the roster
  {start:"2027-01-22",aFri:"2027-01-29"}   // pattern restarts, Vickie first
];
// Each school's terms (first and last day of classes) and extra days it's
// closed. School runs show on days at least one child has school. Children
// not listed in any school use the first one.
// Kendall and Brooklyn's 2027 terms are estimated from their 2026 dates.
var SCHOOLS=[
  {kids:["Kendall","Brooklyn"],
   terms:[["2026-07-20","2026-09-25"],["2026-10-12","2026-12-11"],["2027-02-01","2027-04-09"],["2027-04-26","2027-07-02"],["2027-07-19","2027-09-24"],["2027-10-11","2027-12-10"]],
   closed:{}},
  {kids:["Sidney"],
   terms:[["2026-07-20","2026-09-25"],["2026-10-12","2026-12-16"],["2027-02-03","2027-04-02"],["2027-04-27","2027-07-02"],["2027-07-19","2027-09-24"],["2027-10-11","2027-12-15"]],
   closed:{"2027-03-30":"Easter Tuesday, school closed","2027-11-11":"Teacher-only day"}}
];
// BLOCKS: school holiday weeks and other set days, which win over the pattern.
var BLOCKS=[
  ["2026-09-28","2026-10-04","a"],["2026-10-05","2026-10-11","b"],
  ["2027-01-25","2027-01-28","b"],["2027-02-01","2027-02-05","a"],["2027-02-06","2027-02-08","b"],
  ["2027-04-12","2027-04-18","b"],["2027-04-19","2027-04-25","a"],
  ["2027-07-05","2027-07-11","b"],["2027-07-12","2027-07-18","a"],
  ["2027-09-27","2027-10-03","b"],["2027-10-04","2027-10-10","a"]
];
var HOL={"2026-10-26":"Labour Day","2026-11-13":"Canterbury Anniversary","2026-12-25":"Christmas Day","2026-12-26":"Boxing Day","2026-12-28":"Boxing Day (observed)","2027-01-01":"New Year's Day","2027-01-02":"Day after New Year's Day","2027-01-04":"Day after New Year's Day (observed)","2027-02-06":"Waitangi Day","2027-02-08":"Waitangi Day (observed)","2027-03-26":"Good Friday","2027-03-29":"Easter Monday","2027-04-25":"ANZAC Day","2027-04-26":"ANZAC Day (observed)","2027-06-07":"King's Birthday","2027-06-25":"Matariki","2027-11-12":"Canterbury Anniversary","2027-10-25":"Labour Day","2027-12-25":"Christmas Day","2027-12-26":"Boxing Day","2027-12-27":"Christmas Day (observed)","2027-12-28":"Boxing Day (observed)",
  "2028-01-01":"New Year's Day","2028-01-02":"Day after New Year's Day","2028-01-03":"New Year's Day (observed)","2028-01-04":"Day after New Year's Day (observed)","2028-02-06":"Waitangi Day","2028-02-07":"Waitangi Day (observed)","2028-04-14":"Good Friday","2028-04-17":"Easter Monday","2028-04-25":"ANZAC Day","2028-06-05":"King's Birthday","2028-07-14":"Matariki","2028-10-23":"Labour Day","2028-11-17":"Canterbury Anniversary","2028-12-25":"Christmas Day","2028-12-26":"Boxing Day"};

function num(k){var p=k.split("-");return Date.UTC(+p[0],+p[1]-1,+p[2])/DAY}
function key(n){return new Date(n*DAY).toISOString().slice(0,10)}
function dow(n){return new Date(n*DAY).getUTCDay()}
function ok(v){return v==="a"||v==="b"}

var FIXED={};BLOCKS.forEach(function(b){for(var n=num(b[0]);n<=num(b[1]);n++)FIXED[key(n)]=b[2]});
function pattern(k){
  if(FIXED[k])return FIXED[k];
  var n=num(k),d=dow(n);if(d>=1&&d<=4)return null;var fri=n-((d+2)%7),ph=null;
  PHASES.forEach(function(p){if(num(p.start)<=fri)ph=p});
  if(!ph||!ph.aFri)return null;
  return (((fri-num(ph.aFri))/7)%2+2)%2===0?"a":"b";
}

// S holds the saved data: extras, reqs, care, routine, special, acts.
// recompute fills in S.ov (days changed by agreement or set directly),
// S.ovSet (who set a day directly) and S.pend (days with a pending request).
function recompute(S){
  var ov={},ovSet={},pend={},ev=[];
  // Agreed requests and directly set holiday care, applied oldest first so the latest wins.
  (S.reqs||[]).forEach(function(r){if(r.status==="approved")for(var k in r.changes)ev.push({k:k,p:r.changes[k],t:r.respondedAt||""})});
  var care=S.care||{};
  for(var k in care)ev.push({k:k,p:care[k].who,t:care[k].at||"",by:care[k].by});
  ev.sort(function(x,y){return String(x.t).localeCompare(String(y.t))}).forEach(function(e){ov[e.k]=e.p;if(e.by)ovSet[e.k]=e.by;else delete ovSet[e.k]});
  (S.reqs||[]).forEach(function(r){if(r.status==="pending")for(var k in r.changes)pend[k]=1});
  S.ov=ov;S.ovSet=ovSet;S.pend=pend;
}
function owner(S,k){if(ok(S.ov[k]))return S.ov[k];if(ok((S.extras||{})[k]))return S.extras[k];return pattern(k)}
function dayName(S,k){return HOL[k]||(S.special&&S.special[k]&&S.special[k].label)||""}

function schoolOf(n){for(var i=0;i<SCHOOLS.length;i++)if(SCHOOLS[i].kids.indexOf(n)>=0)return SCHOOLS[i];return SCHOOLS[0]}
function schoolOpen(sc,k){
  var d=dow(num(k));if(d===0||d===6||HOL[k]||sc.closed[k])return false;
  return sc.terms.some(function(t){return k>=t[0]&&k<=t[1]});
}
// The children who have school on day k (["*"] stands for everyone when no names are set).
function atSchool(S,k){
  var routine=S.routine||{kids:[]},all=routine.kids.length?routine.kids:["*"],sp=(S.special||{})[k];
  return all.filter(function(n){
    if(!schoolOpen(schoolOf(n),k))return false;
    if(sp&&sp.noSchool&&(!sp.kids||!sp.kids.length||sp.kids.indexOf(n)>=0))return false;
    return true;
  });
}

// One-off changes to a day's runs: S.runs[day][slot] = "a" or "b", where slot
// is "school-drop", "school-pick", or an activity id plus "-drop" or "-pick".
function runFor(S,k,slot){var r=((S.runs||{})[k]||{})[slot];return ok(r)?r:""}
// Who does school drop-off on day k, worked out without looking at the night
// before: a one-off change, a named parent in the routine, or for "who has
// them" on a weekday the calendar leaves open, that weekday's routine night.
// "" when there's no school run or it can't be told yet.
function schoolDrop(S,k){
  var r=S.routine||{},d=dow(num(k)),sc=(r.school||{})[d];
  if(!sc||!atSchool(S,k).length)return "";
  var x=runFor(S,k,"school-drop")||(ok(sc.drop)?sc.drop:"");
  if(!x&&sc.drop==="has"&&!owner(S,k)){var n=(r.nights||{})[d];if(ok(n))x=n}
  return x;
}
// Where the children sleep the night of day k. If a named parent does school
// drop-off the next morning, they sleep there (a Sunday night at the end of a
// weekend goes back for Monday school). Otherwise with whoever has them that
// day on the calendar, otherwise the weekly routine.
function night(S,k){return schoolDrop(S,key(num(k)+1))||owner(S,k)||((S.routine||{}).nights||{})[dow(num(k))]||""}
// "has": in the morning that's where they slept; later it's where they'll sleep.
function resolve(S,w,k,morning){if(ok(w))return w;if(w!=="has")return "";return morning?night(S,key(num(k)-1)):night(S,k)}

function actsOn(S,k){
  var d=dow(num(k));
  return (S.acts||[]).filter(function(a){
    if(a.repeat==="once")return a.date===k;
    if(a.from&&k<a.from||a.until&&k>a.until)return false;
    if(a.days.indexOf(d)<0)return false;
    return true;
  }).sort(function(x,y){return x.start.localeCompare(y.start)});
}

function time12(t){if(!t)return "";var h=+t.slice(0,2),m=t.slice(3);return ((h+11)%12+1)+(m==="00"?"":":"+m)+(h<12?"am":"pm")}
// One run as [label, parent, slot, changed for this day].
function run(S,k,label,slot,w,morning){var o=runFor(S,k,slot);return [label,o||resolve(S,w,k,morning),slot,!!o]}
// Day k's plans in time order: school runs and activities, each with who
// does drop-off and pickup as [label, parent] pairs.
function dayItems(S,k){
  var routine=S.routine||{kids:[]},items=[],d=dow(num(k)),sc=(routine.school||{})[d];
  var sk=sc?atSchool(S,k):[];
  if(sk.length){
    var only=routine.kids.length&&sk.length<routine.kids.length?" ("+sk.join(" and ")+")":"";
    items.push({t:routine.dropTime,title:"School drop-off"+only,kind:"school",by:[run(S,k,"","school-drop",sc.drop,true)]});
    items.push({t:routine.pickTime,title:"School pickup"+only,kind:"school",by:[run(S,k,"","school-pick",sc.pick,false)]});
  }
  actsOn(S,k).forEach(function(a){
    items.push({t:a.start,end:a.end,title:(a.kids.length===routine.kids.length&&a.kids.length>1?"All":a.kids.join(", "))+": "+a.title,
      id:a.id,sub:[a.end?"until "+time12(a.end):"",a.location].filter(Boolean).join(", "),location:a.location,note:a.note,kind:"activity",
      by:[a.drop||runFor(S,k,a.id+"-drop")?run(S,k,"Drop-off",a.id+"-drop",a.drop,false):null,
          a.pick||runFor(S,k,a.id+"-pick")?run(S,k,"Pickup",a.id+"-pick",a.pick,false):null].filter(Boolean)});
  });
  items.sort(function(x,y){return String(x.t).localeCompare(String(y.t))});
  return items;
}

var api={DAY:DAY,PHASES:PHASES,SCHOOLS:SCHOOLS,BLOCKS:BLOCKS,HOL:HOL,num:num,key:key,dow:dow,pattern:pattern,
  recompute:recompute,owner:owner,dayName:dayName,schoolOf:schoolOf,schoolOpen:schoolOpen,atSchool:atSchool,
  night:night,resolve:resolve,runFor:runFor,schoolDrop:schoolDrop,actsOn:actsOn,dayItems:dayItems,time12:time12};
if(typeof module!=="undefined"&&module.exports)module.exports=api;else root.ROSTER=api;
})(this);

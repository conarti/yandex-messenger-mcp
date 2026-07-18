/* extracted verbatim from bundle module 40939 */
const A=/^(\d+)\/(\d+)\/(.+)$/, w=/^1(\d\d)\/(\d+)\/(.+)_(\d{16})$/, C=/^[a-z0-9-]{36}_[a-z0-9-]{36}$/;
const isNil = v => v === null || v === undefined;
const $K = v => !isNil(v);           /* o.$K */
const U = e => C.test(e);            /* TP - isPrivateChatId */
function J(e){ /* s3 - buildThreadId */
  if(U(e.chatId)) return `110/0/${e.chatId}_${e.timestamp}`;
  const t=A.exec(e.chatId)||[], i=t[1], s=t[2], a=t[3];
  if(!i) return;
  const c=parseInt(i,2);
  return isNaN(c)||!$K(c)||c>99 ? undefined : `${100+c}/${s}/${a}_${e.timestamp}`;
}
const j = e => { /* J$ - parseThreadId */
  const t=w.exec(e); if(!t) return;
  const [,i,o,s,a]=t;
  try{ return "10"===i ? {timestamp:parseInt(a,10), chatId:s}
                       : {timestamp:parseInt(a,10), chatId:`${parseInt(i,10)}/${o}/${s}`}; }catch(e){ return; }
};
const TS="1784287503814009";
const G1="a".repeat(36).replace(/a/g,'x'); // placeholder guid-shaped
const cases=[
  {chatId:"0/0/1a2b3c4d-0000-0000-0000-000000000000", timestamp:TS, note:"group"},
  {chatId:"1/0/1a2b3c4d-0000-0000-0000-000000000000", timestamp:TS, note:"channel (prefix 1)"},
  {chatId:"2/1234/1a2b3c4d-0000-0000-0000-000000000000", timestamp:TS, note:"business (prefix 2)"},
  {chatId:"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx_yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy", timestamp:TS, note:"private (guid_guid)"},
];
for(const c of cases){
  const tid=J(c);
  console.log(`${c.note}\n  chatId  : ${c.chatId}\n  threadId: ${tid}\n  roundtrip: ${JSON.stringify(j(tid||""))}\n`);
}

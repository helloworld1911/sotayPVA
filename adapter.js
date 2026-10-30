/* Kết nối trang với API của Worker (thay cho môi trường claude.ai) */
(function(){
  "use strict";
  let loginShown=false;
  function showLogin(msg){
    if(loginShown)return;loginShown=true;
    const s=document.createElement("div");s.className="scrim center";s.style.zIndex="90";
    s.innerHTML='<form class="dialog" id="loginForm" style="max-width:380px"><h3>Sổ Tay Ôn Tập</h3><p>Nhập mật khẩu để mở sổ tay của bạn.</p>'+
      '<div class="fld"><label for="lgPw">Mật khẩu</label><input id="lgPw" type="password" autocomplete="current-password" required></div>'+
      '<p class="zmsg bad" id="lgMsg"></p><div class="acts"><button class="btn primary" type="submit">Đăng nhập</button></div></form>';
    document.body.appendChild(s);
    const f=s.querySelector("#loginForm"),m=s.querySelector("#lgMsg");if(msg)m.textContent=msg;
    setTimeout(()=>s.querySelector("#lgPw").focus(),50);
    f.addEventListener("submit",async e=>{e.preventDefault();m.textContent="";const btn=f.querySelector("button");btn.disabled=true;
      try{const r=await fetch("/api/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:s.querySelector("#lgPw").value})});
        if(r.ok){location.reload();return}const j=await r.json().catch(()=>({}));m.textContent=j.error||"Không đăng nhập được.";}
      catch(err){m.textContent="Không kết nối được máy chủ."}btn.disabled=false});
  }
  async function api(method,path,body){
    let r;
    try{r=await fetch("/api"+path,{method,credentials:"same-origin",headers:body!==undefined?{"content-type":"application/json"}:{},body:body!==undefined?JSON.stringify(body):undefined})}
    catch(e){throw{code:"unavailable",message:"network"}}
    if(r.status===401){showLogin("Phiên đăng nhập đã hết hạn.");throw{code:"unavailable",message:"login"}}
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw{code:r.status===413||r.status===400?"invalid_argument":"unavailable",message:j.error||r.statusText};
    return j;
  }
  const listeners={},cache={};
  function emit(col){
    const docs=(cache[col]||[]).map(x=>({id:x.id,exists:true,data:()=>x.data,metadata:{fromCache:false,hasPendingWrites:false}}));
    const snap={docs,size:docs.length,empty:!docs.length,docChanges:()=>[],metadata:{fromCache:false,hasPendingWrites:false}};
    (listeners[col]||new Set()).forEach(fn=>{try{fn(snap)}catch(e){console.error(e)}});
  }
  async function pull(col){const j=await api("GET","/data/"+col);cache[col]=j.docs||[];emit(col)}
  const pullAll=()=>Object.keys(listeners).forEach(c=>pull(c).catch(()=>{}));
  setInterval(()=>{if(!document.hidden)pullAll()},60000);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)pullAll()});
  const db={collection(col){return{
    onSnapshot(next,err){(listeners[col]||(listeners[col]=new Set())).add(next);pull(col).catch(e=>err&&err(e));return()=>listeners[col].delete(next)},
    doc(id){return{
      async set(data){await api("PUT","/data/"+col+"/"+encodeURIComponent(id),data);const a=cache[col]||(cache[col]=[]);const rec={id,data:JSON.parse(JSON.stringify(data))};const i=a.findIndex(x=>x.id===id);if(i>=0)a[i]=rec;else a.unshift(rec);emit(col)},
      async delete(){await api("DELETE","/data/"+col+"/"+encodeURIComponent(id));cache[col]=(cache[col]||[]).filter(x=>x.id!==id);emit(col)}
    }}
  }}};
  const user={isOwner:async()=>true,canEdit:async()=>true,can:async()=>true,id:async()=>"me"};
  function parseLoose(t){t=String(t||"").trim();try{return JSON.parse(t)}catch(e){}
    const f=t.match(/```(?:json)?\s*([\s\S]*?)```/);if(f){try{return JSON.parse(f[1])}catch(e){}}
    const a=Math.min(...["[","{"].map(c=>{const i=t.indexOf(c);return i<0?Infinity:i})),b=Math.max(t.lastIndexOf("]"),t.lastIndexOf("}"));
    if(a<b)return JSON.parse(t.slice(a,b+1));throw new Error("no json")}
  async function ask(input,opts,asJson){
    opts=opts||{};const prompt=typeof input==="string"?input:(input||[]).map(m=>m.content).join("\n\n");
    let r;
    try{r=await fetch("/api/ai",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({prompt,json:!!asJson}),signal:opts.signal})}
    catch(e){if(e&&e.name==="AbortError")throw{code:"cancelled",message:"cancelled"};throw{code:"upstream_error",message:"network"}}
    if(r.status===401){showLogin("Phiên đăng nhập đã hết hạn.");throw{code:"session_expired",message:"login"}}
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw{code:j.code||(r.status===429?"rate_limited":"upstream_error"),message:j.error||""};
    const text=j.text||"";
    if(opts.onText&&text)try{opts.onText({text,delta:text})}catch(e){}
    if(!asJson)return{text,truncated:!!j.truncated,modelTierApplied:"default"};
    try{return parseLoose(text)}catch(e){throw{code:"invalid_json",message:"invalid json",text}}
  }
  let me=null;
  const ready=(async()=>{try{const r=await fetch("/api/me",{credentials:"same-origin"});if(r.status===401){showLogin();return null}if(!r.ok)return null;return await r.json()}catch(e){return null}})();
  window.claude={async use(name){
    me=await ready;
    if(!me)return new Promise(()=>{}); // chờ đăng nhập
    if(name==="db")return db;
    if(name==="user")return user;
    if(name==="sample"){if(!me.ai)return null;const f=(i,o)=>ask(i,o,false);f.json=(i,o)=>ask(i,o,true);f.limits=async()=>({maxPromptBytes:262144});return f}
    return null;
  }};
  document.addEventListener("DOMContentLoaded",()=>{const st=document.getElementById("status");if(!st)return;
    const b=document.createElement("button");b.textContent="Đăng xuất";b.className="linkbtn";b.style.marginLeft="auto";
    b.addEventListener("click",async()=>{await fetch("/api/logout",{method:"POST"}).catch(()=>{});location.reload()});st.appendChild(b)});
})();

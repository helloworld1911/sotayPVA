/* Kết nối trang với API của Worker: tài khoản, dữ liệu, Claude */
(function(){
  "use strict";
  const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  let authShown=false;
  async function showAuth(msg,mode){
    if(authShown)return;authShown=true;
    let cfg={inviteRequired:false};try{cfg=await (await fetch("/api/config")).json()}catch(e){}
    const s=document.createElement("div");s.className="scrim center";s.style.zIndex="90";
    let tab=mode||"login";
    const render=()=>{s.innerHTML=`<form class="dialog" id="authForm" style="max-width:400px" novalidate>
      <h3>Sổ Tay Ôn Tập</h3>
      <div class="secsw" style="grid-template-columns:1fr 1fr;margin:2px 0 4px"><button type="button" data-tab="login" class="${tab==="login"?"on":""}" style="height:38px;flex-direction:row;font-size:13px">Đăng nhập</button><button type="button" data-tab="register" class="${tab==="register"?"on":""}" style="height:38px;flex-direction:row;font-size:13px">Đăng ký</button></div>
      <p>${tab==="login"?"Đăng nhập để mở sổ tay của bạn.":"Tạo tài khoản mới. Mỗi tài khoản có ghi chú, bộ đề và bộ từ riêng."}</p>
      ${tab==="register"?`<div class="fld"><label for="auName">Tên hiển thị</label><input id="auName" autocomplete="name" maxlength="60" placeholder="VD: Việt Anh"></div>`:""}
      <div class="fld"><label for="auUser">Tên đăng nhập</label><input id="auUser" autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="32" placeholder="VD: vietanh" required></div>
      <div class="fld"><label for="auPw">Mật khẩu</label><input id="auPw" type="password" autocomplete="${tab==="login"?"current-password":"new-password"}" required placeholder="${tab==="register"?"Ít nhất 8 ký tự":""}"></div>
      ${tab==="register"?`<div class="fld"><label for="auPw2">Nhập lại mật khẩu</label><input id="auPw2" type="password" autocomplete="new-password" required></div>
      ${cfg.inviteRequired?`<div class="fld"><label for="auInv">Mã mời</label><input id="auInv" autocomplete="off" required></div>`:""}`:""}
      <p class="zmsg bad" id="auMsg">${esc(msg||"")}</p>
      <div class="acts"><button class="btn primary lg" type="submit" style="width:100%">${tab==="login"?"Đăng nhập":"Tạo tài khoản"}</button></div></form>`;
      msg="";setTimeout(()=>s.querySelector(tab==="register"?"#auName":"#auUser")?.focus(),30)};
    render();document.body.appendChild(s);
    s.addEventListener("click",e=>{const b=e.target.closest("[data-tab]");if(b){tab=b.dataset.tab;render()}});
    s.addEventListener("submit",async e=>{e.preventDefault();const m=s.querySelector("#auMsg");m.textContent="";
      const v=id=>(s.querySelector(id)||{}).value||"";
      const body={username:v("#auUser").trim(),password:v("#auPw")};
      if(!body.username||!body.password){m.textContent="Hãy nhập tên đăng nhập và mật khẩu.";return}
      if(tab==="register"){if(body.password.length<8){m.textContent="Mật khẩu cần ít nhất 8 ký tự.";return}if(body.password!==v("#auPw2")){m.textContent="Hai mật khẩu chưa khớp.";return}body.name=v("#auName").trim();body.invite=v("#auInv").trim()}
      const btn=s.querySelector('button[type="submit"]');btn.disabled=true;
      try{const r=await fetch(tab==="login"?"/api/login":"/api/register",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
        const j=await r.json().catch(()=>({}));
        if(r.ok){if(j.claimed)try{sessionStorage.setItem("st-claimed","1")}catch(e){}location.reload();return}
        m.textContent=j.error||"Không thực hiện được, thử lại nhé.";}
      catch(err){m.textContent="Không kết nối được máy chủ."}
      btn.disabled=false});
  }
  async function api(method,path,body){
    let r;
    try{r=await fetch("/api"+path,{method,credentials:"same-origin",headers:body!==undefined?{"content-type":"application/json"}:{},body:body!==undefined?JSON.stringify(body):undefined})}
    catch(e){throw{code:"unavailable",message:"network"}}
    if(r.status===401){showAuth("Phiên đăng nhập đã hết hạn, hãy đăng nhập lại.");throw{code:"unavailable",message:"login"}}
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
    if(r.status===401){showAuth("Phiên đăng nhập đã hết hạn, hãy đăng nhập lại.");throw{code:"session_expired",message:"login"}}
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw{code:j.code||(r.status===429?"rate_limited":"upstream_error"),message:j.error||""};
    const text=j.text||"";
    if(opts.onText&&text)try{opts.onText({text,delta:text})}catch(e){}
    if(!asJson)return{text,truncated:!!j.truncated,modelTierApplied:"default"};
    try{return parseLoose(text)}catch(e){throw{code:"invalid_json",message:"invalid json",text}}
  }
  const ready=(async()=>{try{const r=await fetch("/api/me",{credentials:"same-origin"});if(r.status===401){showAuth();return null}if(!r.ok)return null;return await r.json()}catch(e){return null}})();
  window.claude={async use(name){
    const me=await ready;
    if(!me)return new Promise(()=>{});
    if(name==="db")return db;
    if(name==="user")return user;
    if(name==="sample"){if(!me.ai)return null;const f=(i,o)=>ask(i,o,false);f.json=(i,o)=>ask(i,o,true);f.limits=async()=>({maxPromptBytes:262144});return f}
    return null;
  }};
  function changePw(){
    const s=document.createElement("div");s.className="scrim center";s.style.zIndex="90";
    s.innerHTML=`<form class="dialog" style="max-width:400px"><h3>Đổi mật khẩu</h3>
      <div class="fld"><label for="cpOld">Mật khẩu hiện tại</label><input id="cpOld" type="password" autocomplete="current-password"></div>
      <div class="fld"><label for="cpNew">Mật khẩu mới</label><input id="cpNew" type="password" autocomplete="new-password" placeholder="Ít nhất 8 ký tự"></div>
      <div class="fld"><label for="cpNew2">Nhập lại mật khẩu mới</label><input id="cpNew2" type="password" autocomplete="new-password"></div>
      <p class="zmsg bad" id="cpMsg"></p><div class="acts"><button type="button" class="btn ghost" data-x>Huỷ</button><button class="btn primary" type="submit">Lưu</button></div></form>`;
    document.body.appendChild(s);setTimeout(()=>s.querySelector("#cpOld").focus(),30);
    s.addEventListener("click",e=>{if(e.target===s||e.target.closest("[data-x]"))s.remove()});
    s.addEventListener("submit",async e=>{e.preventDefault();const m=s.querySelector("#cpMsg"),n=s.querySelector("#cpNew").value;
      if(n.length<8){m.textContent="Mật khẩu mới cần ít nhất 8 ký tự.";return}if(n!==s.querySelector("#cpNew2").value){m.textContent="Hai mật khẩu chưa khớp.";return}
      const r=await fetch("/api/password",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({old:s.querySelector("#cpOld").value,new:n})}).catch(()=>null);
      const j=r?await r.json().catch(()=>({})):{};if(r&&r.ok){s.remove();alertToast("Đã đổi mật khẩu")}else m.textContent=j.error||"Không đổi được mật khẩu."});
  }
  function alertToast(t){let el=document.getElementById("toast");if(!el){el=document.createElement("div");el.id="toast";el.className="toast";document.body.appendChild(el)}el.textContent=t;el.hidden=false;setTimeout(()=>el.hidden=true,2800)}
  document.addEventListener("DOMContentLoaded",async()=>{
    const me=await ready;if(!me||!me.user)return;
    const side=document.getElementById("side"),st=document.getElementById("status");if(!side||!st)return;
    const box=document.createElement("div");box.className="userbox";
    box.innerHTML=`<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;background:var(--surface);border:1px solid var(--line)"><span style="width:30px;height:30px;border-radius:50%;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center;font-weight:700;flex:none">${esc((me.user.name||me.user.username).trim().charAt(0).toUpperCase())}</span><span style="min-width:0;flex:1;display:flex;flex-direction:column;line-height:1.25"><b style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(me.user.name)}</b><small style="color:var(--muted);font-size:11.5px">@${esc(me.user.username)}</small></span></div>
      <div style="display:flex;gap:4px;padding:4px 4px 0"><button class="linkbtn" data-cp>Đổi mật khẩu</button><span style="flex:1"></span><button class="linkbtn" data-lo>Đăng xuất</button></div>`;
    st.style.marginTop="0";side.insertBefore(box,st);box.style.marginTop="auto";
    box.querySelector("[data-cp]").addEventListener("click",changePw);
    box.querySelector("[data-lo]").addEventListener("click",async()=>{await fetch("/api/logout",{method:"POST"}).catch(()=>{});location.reload()});
    try{if(sessionStorage.getItem("st-claimed")){sessionStorage.removeItem("st-claimed");setTimeout(()=>alertToast("Chào mừng! Dữ liệu cũ đã được chuyển vào tài khoản của bạn."),800)}}catch(e){}
  });
})();

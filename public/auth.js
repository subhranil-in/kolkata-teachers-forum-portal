(() => {
  const config = window.KTF_FIREBASE_CONFIG || {};
  if (!config.apiKey || config.apiKey.startsWith('YOUR_')) {
    document.querySelectorAll('[data-auth-message]').forEach(el => el.textContent = 'Firebase is not configured yet. Follow the setup steps in README.md.');
    return;
  }
  firebase.initializeApp(config);
  const auth = firebase.auth();
  const api = async (path, options = {}) => {
    const user = auth.currentUser; if (!user) throw new Error('Please sign in first.');
    const token = await user.getIdToken();
    const res = await fetch(`${window.KTF_API_BASE}${path}`, { ...options, headers: { 'content-type':'application/json', authorization:`Bearer ${token}`, ...(options.headers||{}) } });
    const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Request failed'); return data;
  };
  window.KTF = { auth, api };
  const selectedPlan = new URLSearchParams(location.search).get('plan'); if (selectedPlan && document.querySelector('#checkoutPlan option[value="'+selectedPlan+'"]')) document.querySelector('#checkoutPlan').value = selectedPlan;
  auth.onAuthStateChanged(user => {
    document.querySelectorAll('[data-auth-email]').forEach(el => el.textContent = user?.email || 'Not signed in');
    if (location.pathname.endsWith('/dashboard.html') || location.pathname.endsWith('/admin.html')) {
      if (!user) location.href = '/login.html';
      else if (location.pathname.endsWith('/dashboard.html')) loadDashboard();
      else loadAdmin();
    }
  });

async function loadDashboard() {
  const ads = document.querySelector('#myAds');
  const pay = document.querySelector('#myPayments');

  try {
    show('#dashboardMessage', 'Loading your account information…');

    const d = await api('/api/me');

    const member = document.querySelector('#memberName');
    if (member) member.textContent = d.member?.fullName || 'Member';

    const status = (d.subscriptions || []).find(s => s.status === 'ACTIVE') || (d.subscriptions || [])[0];

    const values = {
      '#membershipStatus': status?.status || 'No membership',
      '#membershipPlan': status?.plan_name || '—',
      '#membershipExpiry': status?.current_period_end || '—'
    };

    Object.entries(values).forEach(([sel, val]) => {
      const el = document.querySelector(sel);
      if (el) el.textContent = val;
    });

    if (ads) {
      ads.innerHTML = (d.advertisements || []).length
        ? d.advertisements.map(a => `
            <div class="list-row">
              <div>
                <b>${esc(a.title)}</b>
                <div class="small muted">${esc(a.category)} · ${new Date(a.submitted_at).toLocaleDateString()}</div>
              </div>
              <span class="pill">${esc(a.status)}</span>
            </div>
          `).join('')
        : '<p class="muted small">No advertisements submitted yet.</p>';
    }

    if (pay) {
      pay.innerHTML = (d.payments || []).length
        ? d.payments.map(p => `
            <div class="list-row">
              <span>₹${(Number(p.amount_paise || 0) / 100).toFixed(2)}</span>
              <span class="pill">${esc(p.status)}</span>
            </div>
          `).join('')
        : '<p class="muted small">No payment records yet.</p>';
    }

    show('#dashboardMessage', '');
  } catch (e) {
    if (ads) ads.innerHTML = '<p class="muted small">Could not load advertisements.</p>';
    if (pay) pay.innerHTML = '<p class="muted small">Could not load payment history.</p>';
    show('#dashboardMessage', 'Dashboard error: ' + e.message);
  }
}

  async function loadAdmin() {
    try {
      const o = await api('/api/admin/overview');
      [['#adminMembers',o.members],['#adminActive',o.activeSubscriptions],['#adminPending',o.pendingAds],['#adminRevenue',`₹${(o.collectedPaise/100).toFixed(2)}`]].forEach(([s,v])=>{const el=document.querySelector(s);if(el)el.textContent=v;});
      const q=await api('/api/admin/ads?status=PENDING'); const body=document.querySelector('#adminQueue');
      if(body) body.innerHTML=q.advertisements.length?q.advertisements.map(a=>`<tr><td>${esc(a.business_name)}<div class="small muted">${esc(a.email)}</div></td><td><b>${esc(a.title)}</b><div class="small muted">${esc(a.body)}</div></td><td><span class="pill">${esc(a.status)}</span></td><td><button class="btn btn-small" data-review="APPROVED" data-id="${a.id}">Approve</button> <button class="btn btn-small btn-danger" data-review="REJECTED" data-id="${a.id}">Reject</button></td></tr>`).join(''):'<tr><td colspan="4" class="muted">No pending advertisements.</td></tr>';
      body?.querySelectorAll('[data-review]').forEach(btn=>btn.addEventListener('click',async()=>{try{await api(`/api/admin/ads/${btn.dataset.id}/review`,{method:'POST',body:JSON.stringify({status:btn.dataset.review})});loadAdmin();}catch(e){show('#adminMessage',e.message);}}));
      const approved=await api('/api/admin/ads?status=APPROVED'); const approvedBody=document.querySelector('#approvedQueue'); if(approvedBody) approvedBody.innerHTML=approved.advertisements.length?approved.advertisements.map(a=>`<tr><td>${esc(a.business_name)}</td><td><b>${esc(a.title)}</b><div class="small muted">${esc(a.body)}</div></td><td><span class="pill">APPROVED</span></td><td><button class="btn btn-small" data-publish="${a.id}">Mark published</button></td></tr>`).join(''):'<tr><td colspan="4" class="muted">No approved posts awaiting publication.</td></tr>'; approvedBody?.querySelectorAll('[data-publish]').forEach(btn=>btn.addEventListener('click',async()=>{try{await api(`/api/admin/ads/${btn.dataset.publish}/review`,{method:'POST',body:JSON.stringify({status:'PUBLISHED'})});loadAdmin();}catch(e){show('#adminMessage',e.message);}}));
    } catch(e) { show('#adminMessage',e.message); }
  }
  const esc = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const show = (sel,msg) => {const el=document.querySelector(sel);if(el)el.textContent=msg;};
  document.querySelector('#registerForm')?.addEventListener('submit',async e=>{
    e.preventDefault(); const f=new FormData(e.currentTarget); const msg=document.querySelector('#message');
    try { const cred=await auth.createUserWithEmailAndPassword(f.get('email'),f.get('password')); await api('/api/members',{method:'POST',body:JSON.stringify({fullName:f.get('name'),businessName:f.get('business'),phone:f.get('phone')})}); msg.textContent='Account created. Opening your dashboard…'; location.href='/dashboard.html?plan='+encodeURIComponent(f.get('plan'));  }
    catch(err){msg.textContent=err.message;}
  });
  document.querySelector('#loginForm')?.addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await auth.signInWithEmailAndPassword(f.get('email'),f.get('password'));location.href='/dashboard.html';}catch(err){show('#message',err.message);}});
  document.querySelector('#logout')?.addEventListener('click',()=>auth.signOut().then(()=>location.href='/'));
  document.querySelector('#adForm')?.addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api('/api/ads',{method:'POST',body:JSON.stringify({title:f.get('title'),category:f.get('category'),body:f.get('body'),externalUrl:f.get('externalUrl')})});show('#adMessage','Advertisement submitted for review.');e.currentTarget.reset();loadDashboard();}catch(err){show('#adMessage',err.message);}});
  document.querySelector('#checkoutForm')?.addEventListener('submit',async e=>{e.preventDefault();const plan=document.querySelector('#checkoutPlan').value;try{const user=auth.currentUser;const token=await user.getIdToken();const res=await fetch(`${window.KTF_API_BASE}/api/subscriptions/checkout`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({planId:plan})});if(!res.ok){const d=await res.json();throw new Error(d.error||'Checkout could not start');}document.open();document.write(await res.text());document.close();}catch(err){show('#checkoutMessage',err.message);}});
})();

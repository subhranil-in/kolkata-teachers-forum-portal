/** KTF Member Portal API — Cloudflare Worker + D1 + Firebase Auth + PayU Hosted SI.
 *  PayU automatic renewal execution is deliberately not enabled here: it requires
 *  PayU to confirm API-managed SI vs Zion and provide the matching mandate/webhook spec.
 */
const enc = new TextEncoder();
const PLANS = {
  consultancy_yearly: { name: 'KTF Consultancy Membership', amount: '1000.00', paise: 100000, cycle: 'YEARLY', interval: 1, days: 365 },
  advertiser_monthly: { name: 'KTF Advertisement Access', amount: '50.00', paise: 5000, cycle: 'MONTHLY', interval: 1, days: 30 }
};
const CORS_HEADERS = { 'access-control-allow-headers': 'content-type,authorization', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'vary': 'Origin' };
const json = (data, status = 200, origin = '') => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS_HEADERS, 'access-control-allow-origin': origin || 'null' } });
const html = (body, status = 200, origin = '') => new Response(body, {
  status,
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...CORS_HEADERS,
    'access-control-allow-origin': origin || 'null'
  }
}); => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
const sha512 = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-512', enc.encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
const safeEqual = (a, b) => { if (!a || !b || a.length !== b.length) return false; let v = 0; for (let i = 0; i < a.length; i++) v |= a.charCodeAt(i) ^ b.charCodeAt(i); return v === 0; };
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const uuid = () => crypto.randomUUID();
function originAllowed(request, env) { const o = request.headers.get('Origin') || ''; return o && (o === env.APP_ORIGIN || (env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).includes(o)) ? o : ''; }
async function bodyJson(request) { try { return await request.json(); } catch { throw new Error('A valid JSON request body is required'); } }
async function verifyFirebaseToken(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) throw new Error('Sign in is required');
  const token = header.slice(7); const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid authentication token');
  const decode = s => { const b64=s.replace(/-/g,'+').replace(/_/g,'/'); return JSON.parse(atob(b64 + '='.repeat((4-b64.length%4)%4))); };
  const headerData = decode(parts[0]), claims = decode(parts[1]);
  if (headerData.alg !== 'RS256' || !headerData.kid) throw new Error('Unsupported authentication token');
  const project = env.FIREBASE_PROJECT_ID;
  if (!project) throw new Error('Firebase is not configured');
  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== project || claims.iss !== `https://securetoken.google.com/${project}` || !claims.sub || claims.sub.length > 128 || claims.exp <= now || claims.iat > now + 60 || claims.auth_time > now + 60) throw new Error('Authentication token is expired or invalid');
  const certRes = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  if (!certRes.ok) throw new Error('Could not validate sign-in with Firebase');
  const jwks = await certRes.json(); const jwk = (jwks.keys || []).find(k => k.kid === headerData.kid && k.alg === 'RS256');
  if (!jwk) throw new Error('Authentication signing key is not recognised');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const signature = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, enc.encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new Error('Authentication token signature is invalid');
  return { uid: claims.sub, email: claims.email || '', name: claims.name || '' };
}
function isAdmin(user, env) { return (env.ADMIN_FIREBASE_UIDS || '').split(',').map(x => x.trim()).filter(Boolean).includes(user.uid); }
async function requireMember(user, env) {
  const member = await env.DB.prepare('SELECT * FROM members WHERE firebase_uid = ?').bind(user.uid).first();
  if (!member) throw new Error('Complete your member registration first');
  return member;
}
function payuEndpoint(env) { return env.PAYU_ENV === 'production' ? 'https://secure.payu.in/_payment' : 'https://test.payu.in/_payment'; }
function payuPostEndpoint(env) { return env.PAYU_ENV === 'production' ? 'https://info.payu.in/merchant/postservice.php?form=2' : 'https://test.payu.in/merchant/postservice.php?form=2'; }
function addDays(date, days) { const d = new Date(date); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
async function verifyPayuPostback(p, env) {
  if (!p.hash || p.key !== env.PAYU_KEY || !p.txnid || !p.status) return false;
  const raw = `${env.PAYU_SALT}|${p.status}||||||${p.udf5 || ''}|${p.udf4 || ''}|${p.udf3 || ''}|${p.udf2 || ''}|${p.udf1 || ''}|${p.email || ''}|${p.firstname || ''}|${p.productinfo || ''}|${p.amount || ''}|${p.txnid}|${p.key}`;
  return safeEqual((await sha512(raw)).toLowerCase(), String(p.hash).toLowerCase());
}
async function verifyPayuTransaction(txnid, env) {
  const hash = await sha512(`${env.PAYU_KEY}|verify_payment|${txnid}|${env.PAYU_SALT}`);
  const form = new URLSearchParams({ key: env.PAYU_KEY, command: 'verify_payment', var1: txnid, hash });
  const response = await fetch(payuPostEndpoint(env), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  if (!response.ok) throw new Error('PayU verification service unavailable');
  const data = await response.json();
  const detail = data.transaction_details?.[txnid];
  if (!detail) throw new Error('PayU did not return a transaction record');
  return detail;
}
async function settleConsent(p, env) {
  const pending = await env.DB.prepare('SELECT s.*, m.email, m.full_name, pl.amount_paise, pay.id AS payment_id FROM subscriptions s JOIN members m ON m.id=s.member_id JOIN plans pl ON pl.id=s.plan_id JOIN payments pay ON pay.subscription_id=s.id WHERE s.payu_txnid=?').bind(p.txnid).first();
  if (!pending) throw new Error('Unknown payment reference');
  if (String(p.amount) !== (pending.amount_paise / 100).toFixed(2)) throw new Error('Payment amount mismatch');
  const detail = await verifyPayuTransaction(p.txnid, env);
  const status = String(detail.status || '').toLowerCase();
  const verifiedAmount = Number(detail.amt ?? detail.transaction_amount ?? detail.amount);
  if (String(detail.txnid || p.txnid) !== p.txnid || !Number.isFinite(verifiedAmount) || verifiedAmount.toFixed(2) !== (pending.amount_paise / 100).toFixed(2)) throw new Error('Verified PayU transaction amount or reference does not match KTF records');
  const success = status === 'success' || status === 'captured';
  const failed = status === 'failure' || status === 'failed';
  const payuId = String(detail.mihpayid || p.mihpayid || '');
  await env.DB.batch([
    env.DB.prepare('UPDATE payments SET status=?, provider_txn_id=?, raw_reference=? WHERE id=?').bind(success ? 'SUCCESS' : failed ? 'FAILED' : 'PENDING', payuId, JSON.stringify({ status: detail.status, unmappedstatus: detail.unmappedstatus || null }), pending.payment_id),
    env.DB.prepare('UPDATE subscriptions SET status=?, mandate_status=?, payu_mihpayid=?, payu_auth_ref_id=?, started_at=CASE WHEN ?=1 THEN COALESCE(started_at,CURRENT_TIMESTAMP) ELSE started_at END, current_period_end=CASE WHEN ?=1 THEN date(CURRENT_TIMESTAMP, ?) ELSE current_period_end END WHERE id=?').bind(success ? 'ACTIVE' : failed ? 'FAILED' : 'PENDING', success ? 'CONSENT_SUCCESS' : failed ? 'FAILED' : 'PENDING', payuId, payuId, success ? 1 : 0, success ? 1 : 0, `+${pending.plan_id === 'consultancy_yearly' ? 365 : 30} days`, pending.id)
  ]);
}
async function adminRoute(request, url, env, user, origin) {
  if (!isAdmin(user, env)) return json({ error: 'Administrator access required' }, 403, origin);
  if (url.pathname === '/api/admin/overview' && request.method === 'GET') {
    const [members, active, pending, revenue] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) n FROM members').first(), env.DB.prepare("SELECT COUNT(*) n FROM subscriptions WHERE status='ACTIVE'").first(),
      env.DB.prepare("SELECT COUNT(*) n FROM advertisements WHERE status='PENDING'").first(), env.DB.prepare("SELECT COALESCE(SUM(amount_paise),0) n FROM payments WHERE status='SUCCESS'").first()
    ]);
    return json({ members: members.n, activeSubscriptions: active.n, pendingAds: pending.n, collectedPaise: revenue.n }, 200, origin);
  }
  if (url.pathname === '/api/admin/ads' && request.method === 'GET') {
    const status = url.searchParams.get('status') || 'PENDING';
    const rows = await env.DB.prepare('SELECT a.*,m.full_name,m.business_name,m.email,m.phone FROM advertisements a JOIN members m ON m.id=a.member_id WHERE a.status=? ORDER BY a.submitted_at ASC LIMIT 100').bind(status).all();
    return json({ advertisements: rows.results || [] }, 200, origin);
  }
  const match = url.pathname.match(/^\/api\/admin\/ads\/([0-9a-f-]+)\/review$/i);
  if (match && request.method === 'POST') {
    const b = await bodyJson(request); const status = String(b.status || '').toUpperCase();
    if (!['APPROVED','REJECTED','PUBLISHED'].includes(status)) return json({ error: 'Status must be APPROVED, REJECTED or PUBLISHED' }, 400, origin);
    const ad = await env.DB.prepare('SELECT id,status FROM advertisements WHERE id=?').bind(match[1]).first();
    if (!ad) return json({ error: 'Advertisement not found' }, 404, origin);
    if (status === 'PUBLISHED' && ad.status !== 'APPROVED') return json({ error: 'Approve an advertisement before marking it published' }, 409, origin);
    await env.DB.batch([env.DB.prepare('INSERT INTO admin_audit(id,admin_uid,action,target_id,details) VALUES(?,?,?,?,?)').bind(uuid(),user.uid,`ADVERTISEMENT_${status}`,match[1],JSON.stringify({note:String(b.note||'').slice(0,1000)})), env.DB.prepare('UPDATE advertisements SET status=?,admin_note=?,reviewed_at=CASE WHEN ? IN (\'APPROVED\',\'REJECTED\') THEN CURRENT_TIMESTAMP ELSE reviewed_at END,published_at=CASE WHEN ?=\'PUBLISHED\' THEN CURRENT_TIMESTAMP ELSE published_at END,published_by=CASE WHEN ?=\'PUBLISHED\' THEN ? ELSE published_by END WHERE id=?').bind(status, String(b.note || '').slice(0, 1000), status, status, status, user.uid, match[1])]);
    return json({ ok: true, status }, 200, origin);
  }
  return json({ error: 'Admin endpoint not found' }, 404, origin);
}
export default {
 async fetch(request, env) {
  const url = new URL(request.url); const origin = originAllowed(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { headers: { ...CORS_HEADERS, 'access-control-allow-origin': origin || 'null' } });
  if (url.pathname === '/api/health' && request.method === 'GET') return json({ ok: true, service: 'KTF Member Portal API', database: Boolean(env.DB), firebase: Boolean(env.FIREBASE_PROJECT_ID), payuEnvironment: env.PAYU_ENV || 'test', recurringMode: 'HOSTED_SI_CONSENT_ONLY' }, 200, origin);
  if (url.pathname === '/api/plans' && request.method === 'GET') return json({ plans: [
    { id: 'consultancy_yearly', name: PLANS.consultancy_yearly.name, amount: 1000, currency: 'INR', cycle: 'YEARLY' },
    { id: 'advertiser_monthly', name: PLANS.advertiser_monthly.name, amount: 50, currency: 'INR', cycle: 'MONTHLY' },
    { id: 'consultancy_instalments', name: 'Consultancy instalments', amount: 500, currency: 'INR', cycle: 'MANUAL_TWO_INSTALMENTS', checkoutEnabled: false }
  ] }, 200, origin);
  if (url.pathname === '/api/payu/return' && request.method === 'POST') {
    try {
      const p = Object.fromEntries(await request.formData());
      if (!await verifyPayuPostback(p, env)) return html('<h1>Payment response could not be verified</h1><p>Please contact KTF support. Do not retry until the payment status is checked.</p>', 400);
      await settleConsent(p, env);
      return Response.redirect(`${env.APP_ORIGIN}/dashboard.html?payment=checking`, 303);
    } catch (e) { return html(`<h1>Payment status pending verification</h1><p>${escapeHtml(e.message)}</p><p>Sign in to your KTF dashboard later to check the updated status.</p>`, 202); }
  }
  if (url.pathname === '/api/payu/webhook' && request.method === 'POST') {
    // PayU webhook schema/signature varies by product and enabled model. Never trust an
    // unverified callback. Until KTF confirms its PayU mode, require postback + verify_payment.
    return json({ error: 'Webhook endpoint is not activated. Configure the exact PayU webhook signature/event contract first.' }, 501, origin);
  }
  if (!url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404, origin);
  if (!env.DB) return json({ error: 'Database binding DB is not configured' }, 503, origin);
  let user;
  try { user = await verifyFirebaseToken(request, env); }
  catch (e) { return json({ error: e.message || 'Authentication failed' }, 401, origin); }
  try {
    if (url.pathname.startsWith('/api/admin/')) return await adminRoute(request, url, env, user, origin);
    if (url.pathname === '/api/members' && request.method === 'POST') {
      const b = await bodyJson(request); const fullName = String(b.fullName || user.name || '').trim(); const business = String(b.businessName || '').trim(); const email = String(user.email || b.email || '').trim().toLowerCase(); const phone = String(b.phone || '').replace(/[^0-9+]/g, '');
      if (fullName.length < 2 || fullName.length > 100 || business.length < 2 || business.length > 140 || !/^\S+@\S+\.\S+$/.test(email) || !/^\+?[0-9]{10,15}$/.test(phone)) return json({ error: 'Enter a valid name, business name, email and mobile number' }, 400, origin);
      const id = uuid(); await env.DB.prepare('INSERT INTO members(id,firebase_uid,full_name,business_name,email,phone) VALUES(?,?,?,?,?,?) ON CONFLICT(firebase_uid) DO UPDATE SET full_name=excluded.full_name,business_name=excluded.business_name,email=excluded.email,phone=excluded.phone').bind(id, user.uid, fullName, business, email, phone).run();
      const member = await requireMember(user, env); return json({ ok: true, member: { fullName: member.full_name, businessName: member.business_name, email: member.email, phone: member.phone } }, 201, origin);
    }
    if (url.pathname === '/api/me' && request.method === 'GET') {
      const m = await requireMember(user, env);
      const [subs, ads, payments] = await Promise.all([
        env.DB.prepare('SELECT s.id,s.plan_id,s.status,s.mandate_status,s.current_period_end,s.created_at,p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.member_id=? ORDER BY s.created_at DESC').bind(m.id).all(),
        env.DB.prepare('SELECT id,title,category,body,external_url,status,admin_note,submitted_at,reviewed_at,published_at FROM advertisements WHERE member_id=? ORDER BY submitted_at DESC LIMIT 50').bind(m.id).all(),
        env.DB.prepare('SELECT p.id,p.amount_paise,p.status,p.created_at,s.plan_id FROM payments p JOIN subscriptions s ON s.id=p.subscription_id WHERE s.member_id=? ORDER BY p.created_at DESC LIMIT 30').bind(m.id).all()
      ]);
      return json({ member: { fullName:m.full_name,businessName:m.business_name,email:m.email,phone:m.phone }, subscriptions:subs.results||[], advertisements:ads.results||[], payments:payments.results||[] }, 200, origin);
    }
    if (url.pathname === '/api/ads' && request.method === 'POST') {
      const m = await requireMember(user, env); const b = await bodyJson(request); const title = String(b.title||'').trim(), category = String(b.category||'').trim(), body = String(b.body||'').trim(), link = String(b.externalUrl||'').trim();
      if (title.length < 4 || title.length > 120 || !['Teacher requirement','Educational service','Course / training','Other promotion'].includes(category) || body.length < 20 || body.length > 3000) return json({ error: 'Check the advertisement title, category and text length' }, 400, origin);
      if (link && (!/^https:\/\//i.test(link) || link.length > 500)) return json({ error: 'External links must be valid HTTPS URLs' }, 400, origin);
      const id=uuid(); await env.DB.prepare('INSERT INTO advertisements(id,member_id,title,category,body,external_url) VALUES(?,?,?,?,?,?)').bind(id,m.id,title,category,body,link||null).run();
      return json({ ok:true,id,status:'PENDING' },201,origin);
    }
    if (url.pathname === '/api/subscriptions/checkout' && request.method === 'POST') {
      if (!env.PAYU_KEY || !env.PAYU_SALT || !env.APP_ORIGIN) return json({ error:'PayU merchant secrets or APP_ORIGIN are not configured' },503,origin);
      const m=await requireMember(user,env); const b=await bodyJson(request); const plan=PLANS[b.planId];
      if (!plan) return json({ error:'This plan cannot be checked out online. Contact KTF for the two-instalment option.' },400,origin);
      const existing=await env.DB.prepare("SELECT id FROM subscriptions WHERE member_id=? AND plan_id=? AND status IN ('PENDING','ACTIVE') LIMIT 1").bind(m.id,b.planId).first();
      if(existing) return json({ error:'A pending or active subscription for this plan already exists. Check your dashboard or contact KTF.' },409,origin);
      const txnid=`KTF${Date.now()}${crypto.getRandomValues(new Uint32Array(1))[0].toString(16)}`.slice(0,25); const subId=uuid(), paymentId=uuid();
      const start=addDays(new Date(),plan.days), end=addDays(new Date(),3650);
      const siDetails=JSON.stringify({ billingAmount:plan.amount,billingCurrency:'INR',billingCycle:plan.cycle,billingInterval:plan.interval,paymentStartDate:start,paymentEndDate:end });
      const firstname=m.full_name.slice(0,60); const email=m.email;
      const hash=await sha512(`${env.PAYU_KEY}|${txnid}|${plan.amount}|${plan.name}|${firstname}|${email}|||||||||||${siDetails}|${env.PAYU_SALT}`);
      await env.DB.batch([
        env.DB.prepare('INSERT INTO subscriptions(id,member_id,plan_id,payu_txnid,status,mandate_status) VALUES(?,?,?,? ,\'PENDING\',\'PENDING\')').bind(subId,m.id,b.planId,txnid),
        env.DB.prepare('INSERT INTO payments(id,subscription_id,amount_paise,status) VALUES(?,?,?,\'PENDING\')').bind(paymentId,subId,plan.paise)
      ]);
      const fields={key:env.PAYU_KEY,txnid,amount:plan.amount,productinfo:plan.name,firstname,email,phone:m.phone,si:'1',si_details:siDetails,api_version:'7',surl:`${env.API_ORIGIN || env.WORKER_ORIGIN || new URL(request.url).origin}/api/payu/return`,furl:`${env.API_ORIGIN || env.WORKER_ORIGIN || new URL(request.url).origin}/api/payu/return`,hash};
      const inputs=Object.entries(fields).map(([k,v])=>`<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('');
      return html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Redirecting to PayU</title></head><body><p>Redirecting securely to PayU…</p><form id="p" method="post" action="${payuEndpoint(env)}">${inputs}<noscript><button>Continue</button></noscript></form><script>document.getElementById('p').submit()</script></body></html>`, 200, origin);
    }
    return json({ error:'API endpoint not found' },404,origin);
  } catch(e) { return json({ error:e.message || 'Request failed' },400,origin); }
 }
};

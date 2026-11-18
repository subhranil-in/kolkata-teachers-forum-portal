(() => {
  const config = window.KTF_FIREBASE_CONFIG || {};

  if (!config.apiKey || config.apiKey.startsWith('YOUR_')) {
    document.querySelectorAll('[data-auth-message]').forEach(el => {
      el.textContent = 'Firebase is not configured yet. Follow the setup steps in README.md.';
    });
    return;
  }

  firebase.initializeApp(config);
  const auth = firebase.auth();

  const api = async (path, options = {}) => {
    const user = auth.currentUser;
    if (!user) throw new Error('Please sign in first.');

    const token = await user.getIdToken();

    const res = await fetch(`${window.KTF_API_BASE}${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Request failed');
    }

    return data;
  };

  window.KTF = { auth, api };

  const selectedPlan = new URLSearchParams(location.search).get('plan');

  if (
    selectedPlan &&
    document.querySelector('#checkoutPlan option[value="' + selectedPlan + '"]')
  ) {
    document.querySelector('#checkoutPlan').value = selectedPlan;
  }

  auth.onAuthStateChanged(user => {
    document.querySelectorAll('[data-auth-email]').forEach(el => {
      el.textContent = user?.email || 'Not signed in';
    });

    if (
      location.pathname.endsWith('/dashboard.html') ||
      location.pathname.endsWith('/dashboard') ||
      location.pathname.endsWith('/admin.html') ||
      location.pathname.endsWith('/admin')
    ) {
      if (!user) {
        location.href = '/login.html';
      } else if (
        location.pathname.endsWith('/dashboard.html') ||
        location.pathname.endsWith('/dashboard')
      ) {
        loadDashboard();
      } else {
        loadAdmin();
      }
    }
  });

  async function loadDashboard() {
    const ads = document.querySelector('#myAds');
    const pay = document.querySelector('#myPayments');

    try {
      show('#dashboardMessage', 'Loading your account information…');

      const d = await api('/api/me');

      const member = document.querySelector('#memberName');

      if (member) {
        member.textContent = d.member?.fullName || 'Member';
      }

      const status =
        (d.subscriptions || []).find(s => s.status === 'ACTIVE') ||
        (d.subscriptions || [])[0];

      const values = {
        '#membershipStatus': status?.status || 'No membership',
        '#membershipPlan': status?.plan_name || '—',
        '#membershipExpiry': status?.current_period_end || '—'
      };

      Object.entries(values).forEach(([sel, val]) => {
        const el = document.querySelector(sel);
        if (el) el.textContent = val;
      });

      // Advertisement history
      if (ads) {
        ads.innerHTML = (d.advertisements || []).length
          ? d.advertisements.map(a => `
              <div class="list-row">
                <div>
                  <b>${esc(a.title)}</b>
                  <div class="small muted">
                    ${esc(a.category)} · ${new Date(a.submitted_at).toLocaleDateString()}
                  </div>
                </div>
                <span class="pill">${esc(a.status)}</span>
              </div>
            `).join('')
          : '<p class="muted small">No advertisements submitted yet.</p>';
      }

      // Payment history and payment action buttons
      if (pay) {
        pay.innerHTML = (d.payments || []).length
          ? d.payments.map(p => {
              const paymentId = esc(p.id);
              const paymentStatus = String(p.status || '').toUpperCase();

              let actionButton = '';

              if (paymentStatus === 'PENDING') {
                actionButton = `
                  <button
                    type="button"
                    class="btn btn-small"
                    data-check-payment="${paymentId}">
                    Check Payment Status
                  </button>
                `;
              } else if (paymentStatus === 'FAILED') {
                actionButton = `
                  <button
                    type="button"
                    class="btn btn-small"
                    data-retry-payment="${paymentId}">
                    Retry Payment
                  </button>
                `;
              }

              return `
                <div class="list-row">
                  <div>
                    <b>₹${(Number(p.amount_paise || 0) / 100).toFixed(2)}</b>
                    <div class="small muted">
                      ${new Date(p.created_at).toLocaleDateString()}
                    </div>
                    <span class="pill">${esc(paymentStatus)}</span>
                  </div>
                  <div>
                    ${actionButton}
                  </div>
                </div>
              `;
            }).join('')
          : '<p class="muted small">No payment records yet.</p>';

        // Check Payment Status buttons
        pay.querySelectorAll('[data-check-payment]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const paymentId = btn.dataset.checkPayment;

            try {
              btn.disabled = true;
              btn.textContent = 'Checking…';

              const result = await api(
                `/api/payments/${paymentId}/check-status`,
                { method: 'POST' }
              );

              show('#dashboardMessage', result.message || 'Payment status checked.');

              await loadDashboard();
            } catch (err) {
              btn.disabled = false;
              btn.textContent = 'Check Payment Status';
              show('#dashboardMessage', err.message);
            }
          });
        });

        // Retry Payment buttons
        pay.querySelectorAll('[data-retry-payment]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const paymentId = btn.dataset.retryPayment;

            try {
              btn.disabled = true;
              btn.textContent = 'Preparing payment…';

              const user = auth.currentUser;

              if (!user) {
                throw new Error('Please sign in first.');
              }

              const token = await user.getIdToken();

              const res = await fetch(
                `${window.KTF_API_BASE}/api/payments/${paymentId}/retry`,
                {
                  method: 'POST',
                  headers: {
                    authorization: `Bearer ${token}`
                  }
                }
              );

              if (!res.ok) {
                let data = {};

                try {
                  data = await res.json();
                } catch (_) {}

                throw new Error(
                  data.error || 'Payment retry could not be started.'
                );
              }

              const html = await res.text();

              document.open();
              document.write(html);
              document.close();

            } catch (err) {
              btn.disabled = false;
              btn.textContent = 'Retry Payment';
              show('#dashboardMessage', err.message);
            }
          });
        });
      }

      show('#dashboardMessage', '');

    } catch (e) {
      if (ads) {
        ads.innerHTML = '<p class="muted small">Could not load advertisements.</p>';
      }

      if (pay) {
        pay.innerHTML = '<p class="muted small">Could not load payment history.</p>';
      }

      show('#dashboardMessage', 'Dashboard error: ' + e.message);
    }
  }

  async function loadAdmin() {
    try {
      const o = await api('/api/admin/overview');

      [
        ['#adminMembers', o.members],
        ['#adminActive', o.activeSubscriptions],
        ['#adminPending', o.pendingAds],
        ['#adminRevenue', `₹${(o.collectedPaise / 100).toFixed(2)}`]
      ].forEach(([s, v]) => {
        const el = document.querySelector(s);
        if (el) el.textContent = v;
      });

      const q = await api('/api/admin/ads?status=PENDING');
      const body = document.querySelector('#adminQueue');

      if (body) {
        body.innerHTML = q.advertisements.length
          ? q.advertisements.map(a => `
              <tr>
                <td>
                  ${esc(a.business_name)}
                  <div class="small muted">${esc(a.email)}</div>
                </td>
                <td>
                  <b>${esc(a.title)}</b>
                  <div class="small muted">${esc(a.body)}</div>
                </td>
                <td><span class="pill">${esc(a.status)}</span></td>
                <td>
                  <button class="btn btn-small" data-review="APPROVED" data-id="${esc(a.id)}">Approve</button>
                  <button class="btn btn-small btn-danger" data-review="REJECTED" data-id="${esc(a.id)}">Reject</button>
                </td>
              </tr>
            `).join('')
          : '<tr><td colspan="4" class="muted">No pending advertisements.</td></tr>';
      }

      body?.querySelectorAll('[data-review]').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            await api(`/api/admin/ads/${btn.dataset.id}/review`, {
              method: 'POST',
              body: JSON.stringify({ status: btn.dataset.review })
            });

            loadAdmin();
          } catch (e) {
            show('#adminMessage', e.message);
          }
        });
      });

      const approved = await api('/api/admin/ads?status=APPROVED');
      const approvedBody = document.querySelector('#approvedQueue');

      if (approvedBody) {
        approvedBody.innerHTML = approved.advertisements.length
          ? approved.advertisements.map(a => `
              <tr>
                <td>${esc(a.business_name)}</td>
                <td>
                  <b>${esc(a.title)}</b>
                  <div class="small muted">${esc(a.body)}</div>
                </td>
                <td><span class="pill">APPROVED</span></td>
                <td>
                  <button class="btn btn-small" data-publish="${esc(a.id)}">
                    Mark published
                  </button>
                </td>
              </tr>
            `).join('')
          : '<tr><td colspan="4" class="muted">No approved posts awaiting publication.</td></tr>';
      }

      approvedBody?.querySelectorAll('[data-publish]').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            await api(`/api/admin/ads/${btn.dataset.publish}/review`, {
              method: 'POST',
              body: JSON.stringify({ status: 'PUBLISHED' })
            });

            loadAdmin();
          } catch (e) {
            show('#adminMessage', e.message);
          }
        });
      });

    } catch (e) {
      show('#adminMessage', e.message);
    }
  }

  const esc = s =>
    String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));

  const show = (sel, msg) => {
    const el = document.querySelector(sel);
    if (el) el.textContent = msg;
  };

  // Registration
  document.querySelector('#registerForm')?.addEventListener('submit', async e => {
    e.preventDefault();

    const f = new FormData(e.currentTarget);
    const msg = document.querySelector('#message');

    try {
      await auth.createUserWithEmailAndPassword(
        f.get('email'),
        f.get('password')
      );

      await api('/api/members', {
        method: 'POST',
        body: JSON.stringify({
          fullName: f.get('name'),
          businessName: f.get('business'),
          phone: f.get('phone')
        })
      });

      msg.textContent = 'Account created. Opening your dashboard…';

      location.href = '/dashboard.html?plan=' +
        encodeURIComponent(f.get('plan'));

    } catch (err) {
      msg.textContent = err.message;
    }
  });

  // Login
  document.querySelector('#loginForm')?.addEventListener('submit', async e => {
    e.preventDefault();

    const f = new FormData(e.currentTarget);

    try {
      await auth.signInWithEmailAndPassword(
        f.get('email'),
        f.get('password')
      );

      location.href = '/dashboard.html';

    } catch (err) {
      show('#message', err.message);
    }
  });

  // Logout
  document.querySelector('#logout')?.addEventListener('click', () => {
    auth.signOut().then(() => {
      location.href = '/';
    });
  });

  // Advertisement submission
  document.querySelector('#adForm')?.addEventListener('submit', async e => {
    e.preventDefault();

    const f = new FormData(e.currentTarget);

    try {
      await api('/api/ads', {
        method: 'POST',
        body: JSON.stringify({
          title: f.get('title'),
          category: f.get('category'),
          body: f.get('body'),
          externalUrl: f.get('externalUrl')
        })
      });

      show('#adMessage', 'Advertisement submitted for review.');

      e.currentTarget.reset();
      loadDashboard();

    } catch (err) {
      show('#adMessage', err.message);
    }
  });

  // Subscription checkout
  document.querySelector('#checkoutForm')?.addEventListener('submit', async e => {
    e.preventDefault();

    const plan = document.querySelector('#checkoutPlan').value;

    try {
      const user = auth.currentUser;
      const token = await user.getIdToken();

      const res = await fetch(
        `${window.KTF_API_BASE}/api/subscriptions/checkout`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ planId: plan })
        }
      );

      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || 'Checkout could not start');
      }

      document.open();
      document.write(await res.text());
      document.close();

    } catch (err) {
      show('#checkoutMessage', err.message);
    }
  });

})();

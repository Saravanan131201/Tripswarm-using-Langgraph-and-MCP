// static/js/home.js

//  Auth Modal 

let _otpEmail = '';

function openAuthModal() {
  const modal = document.getElementById('auth-modal');
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  authShowStep('choose');
}

function closeAuthModal() {
  const modal = document.getElementById('auth-modal');
  modal.style.display = 'none';
  document.body.style.overflow = '';
  // reset fields
  const emailEl = document.getElementById('otp-email');
  const nameEl  = document.getElementById('otp-name');
  if (emailEl) emailEl.value = '';
  if (nameEl)  nameEl.value  = '';
  _clearOtpBoxes();
  _setError('auth-email-error', '');
  _setError('auth-otp-error', '');
}

// Terms Modal 

function openTermsModal() {
  const modal = document.getElementById('terms-modal');
  const agreeBtn = document.getElementById('terms-agree-btn');
  agreeBtn.href = '/auth/login';
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeTermsModal() {
  const modal = document.getElementById('terms-modal');
  modal.classList.remove('open');
  document.body.style.overflow = '';
}

function switchToTermsModal() {
  // Close auth choice modal silently, open terms modal
  const authModal = document.getElementById('auth-modal');
  authModal.style.display = 'none';
  // Don't restore scroll yet — terms modal will keep it locked
  openTermsModal();
}

// Close terms modal on backdrop click
document.getElementById('terms-modal').addEventListener('click', function(e) {
  if (e.target === this) closeTermsModal();
});

document.getElementById('auth-modal').addEventListener('click', function(e) {
  if (e.target === this) closeAuthModal();
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeAuthModal();
});

function authShowStep(step) {
  ['choose', 'email', 'otp'].forEach(s => {
    const el = document.getElementById(`auth-step-${s}`);
    if (el) el.style.display = s === step ? 'block' : 'none';
  });
  if (step === 'otp') {
    setTimeout(() => {
      const boxes = document.querySelectorAll('.otp-box');
      if (boxes[0]) boxes[0].focus();
    }, 100);
    _startResendTimer();
    _initOtpBoxes();
  }
  if (step === 'email') {
    setTimeout(() => {
      const emailEl = document.getElementById('otp-email');
      if (emailEl) emailEl.focus();
    }, 100);
  }
}

function _setError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

function _setBtnLoading(btnId, loading, defaultText) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  if (loading) {
    btn.disabled = true;
    btn.innerHTML = `<span style="display:inline-block;width:16px;height:16px;border:2px solid rgba(0,0,0,0.3);
      border-top-color:#0A1628;border-radius:50%;animation:spin 0.7s linear infinite;"></span> ${defaultText}...`;
  } else {
    btn.disabled = false;
    btn.innerHTML = defaultText;
  }
}

async function sendOtpClick() {
  const emailEl  = document.getElementById('otp-email');
  const nameEl   = document.getElementById('otp-name');
  const nameWrap = document.getElementById('auth-name-wrap');
  const email    = (emailEl?.value || '').trim().toLowerCase();
  const name     = (nameEl?.value  || '').trim();

  _setError('auth-email-error', '');

  if (!email) { _setError('auth-email-error', 'Please enter your Gmail address.'); return; }
  if (!email.endsWith('@gmail.com')) { _setError('auth-email-error', 'Only @gmail.com addresses are accepted.'); return; }

  // If name field is visible and empty → block
  if (nameWrap.style.display !== 'none' && !name) {
    _setError('auth-email-error', 'Please enter your name.');
    return;
  }

  _setBtnLoading('send-otp-btn', true, 'Send OTP');

  try {
    const res  = await fetch('/api/otp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, name }),
    });
    const data = await res.json();

    if (!res.ok) {
      // name_required → show name field and re-prompt
      if (data.detail === 'name_required') {
        nameWrap.style.display = 'block';
        nameEl.focus();
        _setError('auth-email-error', 'You\'re new here! Please enter your name above.');
        return;
      }
      _setError('auth-email-error', data.detail || 'Failed to send OTP.');
      return;
    }

    if (data.is_new_user && nameWrap.style.display === 'none') {
      // Edge case where server said new but we never showed name — shouldn't happen given above
    }

    _otpEmail = email;
    document.getElementById('otp-sent-to').textContent = email;
    authShowStep('otp');

  } catch (err) {
    _setError('auth-email-error', 'Network error. Please try again.');
  } finally {
    _setBtnLoading('send-otp-btn', false, 'Send OTP');
  }
}

function _getOtpValue() {
  return [...document.querySelectorAll('.otp-box')].map(b => b.value).join('');
}

function _clearOtpBoxes() {
  document.querySelectorAll('.otp-box').forEach(b => {
    b.value = '';
    b.style.borderColor = 'rgba(0,212,200,0.25)';
  });
}

function _initOtpBoxes() {
  const boxes = [...document.querySelectorAll('.otp-box')];
  boxes.forEach((box, idx) => {
    box.value = '';
    box.style.borderColor = 'rgba(0,212,200,0.25)';

    box.oninput = () => {
      box.value = box.value.replace(/\D/g, '').slice(0, 1);
      box.style.borderColor = box.value ? '#00D4C8' : 'rgba(0,212,200,0.25)';
      if (box.value && idx < boxes.length - 1) boxes[idx + 1].focus();
      // Auto-verify when all 6 filled
      if (_getOtpValue().length === 6) verifyOtpClick();
    };

    box.onkeydown = (e) => {
      if (e.key === 'Backspace' && !box.value && idx > 0) {
        boxes[idx - 1].focus();
        boxes[idx - 1].value = '';
        boxes[idx - 1].style.borderColor = 'rgba(0,212,200,0.25)';
      }
      if (e.key === 'Enter') verifyOtpClick();
    };

    box.onpaste = (e) => {
      e.preventDefault();
      const pasted = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
      pasted.split('').forEach((ch, i) => {
        if (boxes[i]) { boxes[i].value = ch; boxes[i].style.borderColor = '#00D4C8'; }
      });
      if (pasted.length === 6) verifyOtpClick();
    };
  });
}

async function verifyOtpClick() {
  const otp = _getOtpValue();
  _setError('auth-otp-error', '');

  if (otp.length < 6) { _setError('auth-otp-error', 'Please enter all 6 digits.'); return; }

  _setBtnLoading('verify-otp-btn', true, 'Verify & Sign In');

  try {
    const res  = await fetch('/api/otp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: _otpEmail, otp }),
    });
    const data = await res.json();

    if (!res.ok) {
      _setError('auth-otp-error', data.detail || 'Verification failed.');
      _clearOtpBoxes();
      document.querySelectorAll('.otp-box')[0]?.focus();
      // Shake effect
      const boxes = document.getElementById('otp-boxes');
      boxes.style.animation = 'shake 0.35s ease';
      setTimeout(() => boxes.style.animation = '', 400);
      return;
    }

    // Success → redirect to chat
    closeAuthModal();
    showToast(`Welcome${data.is_new ? '' : ' back'}, ${data.user?.name?.split(' ')[0] || ''}! Redirecting…`);
    setTimeout(() => { window.location.href = '/chat'; }, 900);

  } catch (err) {
    _setError('auth-otp-error', 'Network error. Please try again.');
  } finally {
    _setBtnLoading('verify-otp-btn', false, 'Verify & Sign In');
  }
}

async function resendOtpClick() {
  const resendBtn   = document.getElementById('resend-otp-btn');
  const resendTimer = document.getElementById('resend-timer');
  _setError('auth-otp-error', '');

  resendBtn.disabled = true;
  resendBtn.style.opacity = '0.5';

  try {
    const res = await fetch('/api/otp/resend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: _otpEmail }),
    });
    const data = await res.json();

    if (!res.ok) {
      _setError('auth-otp-error', data.detail || 'Failed to resend.');
      return;
    }

    _clearOtpBoxes();
    document.querySelectorAll('.otp-box')[0]?.focus();
    showToast('New code sent!');
    _startResendTimer();

  } catch {
    _setError('auth-otp-error', 'Network error. Please try again.');
  } finally {
    resendBtn.disabled = false;
    resendBtn.style.opacity = '1';
  }
}

let _resendInterval = null;
function _startResendTimer(seconds = 600) {
  const resendBtn   = document.getElementById('resend-otp-btn');
  const resendTimer = document.getElementById('resend-timer');
  if (!resendBtn || !resendTimer) return;

  resendBtn.style.display   = 'none';
  resendTimer.style.display = 'inline';
  let remaining = seconds;

  function _formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `Resend in ${m}:${sec.toString().padStart(2, '0')}`;
  }

  resendTimer.textContent = _formatTime(remaining);

  clearInterval(_resendInterval);
  _resendInterval = setInterval(() => {
    remaining--;
    if (remaining > 0) {
      resendTimer.textContent = _formatTime(remaining);
    } else {
      clearInterval(_resendInterval);
      resendTimer.style.display = 'none';
      resendBtn.style.display   = 'inline';
      // Auto-trigger resend after OTP expires
      resendOtpClick();
    }
  }, 1000);
}

// Session State — exposed on window so mobile layer can read it
window.SESSION = { loggedIn: false, user: null };
let SESSION = window.SESSION;

const GOOGLE_SVG = `<img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" width="22" height="22" alt="Google" />`;

async function fetchSession() {
  try {
    const res = await fetch('/api/me', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      SESSION.loggedIn = data.logged_in || false;
      SESSION.user     = data.user || null;
    }
  } catch(e) {
    SESSION.loggedIn = false;
  }
  // Always notify mobile layer once session is resolved
  window.SESSION = SESSION;
  window._sessionReady = true;
}

/* ── URL Hash Routing ── */
function applyHashRoute() {
  const hash = window.location.hash || '#home';
  const id   = hash.slice(1);
  const el   = document.getElementById(id);
  if (el) {
    setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }
  updateActiveNavLink(hash);
}

function updateActiveNavLink(hash) {
  document.querySelectorAll('.ts-navbar .nav-link').forEach(link => {
    const href = link.getAttribute('href');
    link.classList.toggle('active', href === hash);
  });
}

document.querySelectorAll('.ts-navbar a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const hash = a.getAttribute('href');
    history.pushState(null, '', hash);
    updateActiveNavLink(hash);
  });
});

window.addEventListener('popstate', applyHashRoute);

/* ── AUTH UI Injection ── */
function renderAuthUI() {
  const navArea    = document.getElementById('nav-auth-area');
  const mobileArea = document.getElementById('mobile-auth-area');
  const heroCta    = document.getElementById('hero-cta-area');
  const heroTrust  = document.getElementById('hero-trust');
  const footerCta  = document.getElementById('footer-cta-area');

  if (SESSION.loggedIn && SESSION.user) {
    const u = SESSION.user;
    const initials = (u.name || u.email || 'U')[0].toUpperCase();
    const avatarHtml = u.picture
      ? `<img src="${u.picture}" alt="avatar">`
      : `<div class="avatar-init">${initials}</div>`;

    
    navArea.innerHTML = `
      <div class="d-flex align-items-center gap-2">
        <a href="/chat" class="nav-cta"><i class="bi bi-airplane-fill me-1"></i>Open App</a>
        <span class="nav-user-pill">${avatarHtml}<span>${u.name || u.email}</span></span>
        <a href="/auth/logout" class="nav-link nav-logout"><i class="bi bi-box-arrow-right"></i> Logout</a>
      </div>`;

    // Mobile menu
    mobileArea.innerHTML = `
      <div class="d-flex flex-column gap-2 mt-1">
        <a href="/chat" class="nav-cta d-inline-flex align-items-center gap-1"><i class="bi bi-airplane-fill"></i> Open App</a>
        <a href="/auth/logout" class="nav-link nav-logout d-inline-flex align-items-center gap-1"><i class="bi bi-box-arrow-right"></i> Logout</a>
      </div>`;

    // Hero CTA
    heroCta.innerHTML = `
      <a href="/chat" class="hero-logged-in-cta">
        <i class="bi bi-rocket-takeoff-fill"></i> Launch TripSwarm
      </a>
      <div class="hero-trust" style="margin-top:1.2rem;">
        <div class="hero-trust-pill"><i class="bi bi-person-check-fill"></i><span>Signed in as ${u.name || u.email}</span></div>
      </div>`;
    heroTrust.style.display = 'none';

    // Footer CTA
    footerCta.innerHTML = `<a href="/chat" class="hero-logged-in-cta" style="font-size:0.82rem;padding:10px 18px;display:inline-flex;"><i class="bi bi-rocket-takeoff-fill"></i> Open TripSwarm</a>`;

  } else {
    

    // Navbar desktop — Sign in button triggers terms modal
    navArea.innerHTML = `
      <button onclick="openAuthModal()" class="nav-cta" style="border:none;cursor:pointer;">
        <i class="bi bi-box-arrow-in-right me-1"></i> Sign in
      </button>`;

    // Mobile menu
    mobileArea.innerHTML = `
      <button onclick="openAuthModal()" class="nav-cta d-inline-flex align-items-center gap-1" style="border:none;cursor:pointer;">
        <i class="bi bi-box-arrow-in-right"></i> Sign in
      </button>`;

    // Hero CTA
    heroCta.innerHTML = `
      <button onclick="openAuthModal()" class="google-btn" id="heroGoogleBtn" style="border:none;">
       <i class="bi bi-box-arrow-in-right success"></i> Sign in to TripSwarm
      </button>`;

    // Footer CTA
    footerCta.innerHTML = `
      <button onclick="openAuthModal()" class="google-btn" style="font-size:15px;padding:10px 18px;border:none;">
       <i class="bi bi-box-arrow-in-right success"></i> Sign in to TripSwarm
      </button>`;
  }

  renderChatBottom();
  renderDestCta();
}

/* ── Chat Widget Bottom ── */
const tabMsgs = {
  plan: '🗺️ Tell me where you want to go! I\'ll deploy Flight, Hotel & Itinerary agents to plan your perfect trip.',
  qa:   '🔍 Ask me anything about travel — visa process, packing tips, culture notes. I\'ll search your uploaded docs too.'
};
const tabPlaceholders = {
  plan: 'e.g. Plan a 5-day trip to Tokyo…',
  qa:   'e.g. What\'s the visa process for Indian passport to Japan?'
};
let activeChatTab = 'plan';

function renderChatBottom() {
  const area = document.getElementById('chat-bottom-area');
  if (SESSION.loggedIn) {
    
    area.innerHTML = `
      <div class="chat-auth-gate">
        <p>You're signed in! Messages are processed in the full app.</p>
        <a href="/chat?mode=${activeChatTab === 'qa' ? 'qa' : 'travel'}" class="hero-logged-in-cta" style="font-size:0.85rem;padding:10px 22px;">
          <i class="bi bi-rocket-takeoff-fill"></i> Open ${activeChatTab === 'qa' ? 'Travel Copilot' : 'Trip Planner'}
        </a>
      </div>
      <div class="chat-input-row">
        <input type="text" class="chat-input" id="chatInput" placeholder="${tabPlaceholders[activeChatTab]}" onkeydown="if(event.key==='Enter') sendChatMsg()" />
        <button class="chat-send" onclick="sendChatMsg()" title="Send"><i class="bi bi-send-fill"></i></button>
      </div>`;
  } else {
   
    area.innerHTML = `
      <div class="chat-auth-gate">
        <p><i class="bi bi-lock-fill" style="color:var(--gold);"></i> Sign in to send messages and save your plans.</p>
        <button onclick="openAuthModal()" class="google-btn" style="font-size:0.85rem;padding:10px 20px;border:none;cursor:pointer;">
          <i class="bi bi-box-arrow-in-right success"></i> Sign in to TripSwarm
        </button>
      </div>
      <div class="chat-input-row">
        <input type="text" class="chat-input" id="chatInput" placeholder="${tabPlaceholders[activeChatTab]}" onkeydown="if(event.key==='Enter') sendChatMsg()" />
        <button class="chat-send" onclick="sendChatMsg()" title="Send"><i class="bi bi-send-fill"></i></button>
      </div>`;
  }
}


function switchChatTab(tab) {
  window._desktopActiveChatTab = tab;
  activeChatTab = tab;
  document.getElementById('tabPlan').classList.toggle('active', tab === 'plan');
  document.getElementById('tabQA').classList.toggle('active', tab === 'qa');

  const input = document.getElementById('chatInput');
  if (input) input.placeholder = tabPlaceholders[tab];

  const msgs = document.getElementById('chatMessages');
  msgs.innerHTML = '';
  addMsg('ai', tabMsgs[tab]);


  const openBtn = document.querySelector('#chat-bottom-area a[href^="/chat"]');
  if (openBtn) {
    const modeParam = tab === 'qa' ? 'rag' : 'travel';
    openBtn.href = `/chat?mode=${modeParam}`;
    openBtn.innerHTML = `<i class="bi bi-rocket-takeoff-fill"></i> Open ${tab === 'qa' ? 'Travel Copilot' : 'Trip Planner'}`;
  }
}

function addMsg(type, text) {
  const msgs = document.getElementById('chatMessages');
  const div  = document.createElement('div');
  div.className = `msg msg-${type}`;
  if (type === 'ai') div.innerHTML = `<div class="msg-sender">TripSwarm</div>${text}`;
  else               div.innerHTML = `<div class="msg-sender" style="color:var(--gold);">You</div>${text}`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function sendChatMsg() {
  const input = document.getElementById('chatInput');
  const text  = input.value.trim();
  if (!text) return;

  if (!SESSION.loggedIn) {
    addMsg('user', text);
    input.value = '';
    setTimeout(() => {
      addMsg('ai', `✋ Please <button onclick="openAuthModal()" style="background:none;border:none;color:var(--teal);font-weight:600;cursor:pointer;padding:0;font-size:inherit;">sign in</button> to use ${activeChatTab === 'qa' ? 'Travel Copilot' : 'the Travel Planner'}.`);
    }, 400);
    return;
  }

  const encoded = encodeURIComponent(text);
  const modeParam = activeChatTab === 'qa' ? 'qa' : 'travel';
  showToast(`Redirecting to ${activeChatTab === 'qa' ? 'Travel Copilot' : 'Trip Planner'}…`);
  setTimeout(() => {
    window.location.href = `/chat?mode=${modeParam}&q=${encoded}`;
  }, 700);
}

/* ── Quick Trip Builder ── */

const destPreviews = {
  'Tokyo 🇯🇵': {
    text: '✈️ <strong>Flight</strong>: MAA → NRT · Multiple carriers available | <strong>Hotel</strong>: Budget to luxury options | 🗓️ <strong>Highlights</strong>: Senso-ji, Shibuya, TeamLab, Ramen tour, Akihabara, Mt. Fuji day trip',
    prompt: 'Plan a 5-day trip to Tokyo from Chennai'
  },
  'Bali 🇮🇩': {
    text: '✈️ <strong>Flight</strong>: MAA → DPS · Direct & connecting options | <strong>Hotel</strong>: Villas & resorts for every budget | 🗓️ <strong>Highlights</strong>: Ubud Monkey Forest, Tegallalang Rice Terrace, Uluwatu Temple, Seminyak beach',
    prompt: 'Plan a 7-day trip to Bali from Chennai'
  },
  'Paris 🇫🇷': {
    text: '✈️ <strong>Flight</strong>: MAA → CDG · Several airlines & routes | <strong>Hotel</strong>: Charming stays across all budgets | 🗓️ <strong>Highlights</strong>: Eiffel Tower, Louvre, Montmartre, Seine cruise, Versailles day trip',
    prompt: 'Plan a 7-day Paris trip from Chennai'
  },
  'Dubai 🇦🇪': {
    text: '✈️ <strong>Flight</strong>: MAA → DXB · Frequent short-haul connections | <strong>Hotel</strong>: From city stays to resort luxury | 🗓️ <strong>Highlights</strong>: Burj Khalifa, Dubai Mall, Desert Safari, Palm Jumeirah, Gold Souk',
    prompt: 'Plan a 5-day Dubai trip from Chennai'
  }
};

let selectedDest = null;

function pickDest(dest) {
  selectedDest = dest;
  document.querySelectorAll('.dest-btn').forEach(b => b.classList.toggle('selected', b.textContent.trim() === dest));
  const preview = document.getElementById('destPreview');
  const data    = destPreviews[dest];
  document.getElementById('destPreviewText').innerHTML = data ? data.text : '';
  preview.style.display = 'block';
  renderDestCta();
}

function renderDestCta() {
  const area = document.getElementById('dest-cta-area');
  if (!area) return;

  if (SESSION.loggedIn && selectedDest) {
    const prompt  = destPreviews[selectedDest]?.prompt || `Plan a trip to ${selectedDest}`;
    const encoded = encodeURIComponent(prompt);
    area.innerHTML = `
      <a href="/chat?mode=travel&q=${encoded}" class="hero-logged-in-cta" style="font-size:0.82rem;padding:10px 20px;">
        <i class="bi bi-rocket-takeoff-fill"></i> Try it in TripSwarm
      </a>`;
  } else if (!SESSION.loggedIn) {
    area.innerHTML = `
      <button onclick="openAuthModal()" class="google-btn" style="font-size:0.8rem;padding:10px 18px;border:none;cursor:pointer;">
        <i class="bi bi-box-arrow-in-right success"></i> Sign in to build this trip
      </button>`;
  } else {
    area.innerHTML = '';
  }
}

/* ── Swarm Canvas ── */
(function() {
  const canvas = document.getElementById('swarm-canvas');
  const ctx    = canvas.getContext('2d');
  let W, H, nodes = [];
  const NODE_COUNT = 55, MAX_DIST = 140, TEAL = '#00D4C8', GOLD = '#F5A623';

  function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
  function initNodes() {
    nodes = Array.from({ length: NODE_COUNT }, (_, i) => ({
      x: Math.random()*W, y: Math.random()*H,
      vx: (Math.random()-0.5)*0.4, vy: (Math.random()-0.5)*0.4,
      r: Math.random()*1.8+0.8, gold: i < 6
    }));
  }
  function draw() {
    ctx.clearRect(0,0,W,H);
    for (let i=0;i<nodes.length;i++) for (let j=i+1;j<nodes.length;j++) {
      const dx=nodes[i].x-nodes[j].x, dy=nodes[i].y-nodes[j].y, d=Math.sqrt(dx*dx+dy*dy);
      if (d<MAX_DIST) { ctx.beginPath(); ctx.moveTo(nodes[i].x,nodes[i].y); ctx.lineTo(nodes[j].x,nodes[j].y); ctx.strokeStyle=`rgba(0,212,200,${(1-d/MAX_DIST)*0.22})`; ctx.lineWidth=0.7; ctx.stroke(); }
    }
    nodes.forEach(n => {
      ctx.beginPath(); ctx.arc(n.x,n.y,n.r,0,Math.PI*2);
      ctx.fillStyle=n.gold?GOLD:TEAL; ctx.globalAlpha=0.7; ctx.fill(); ctx.globalAlpha=1;
      n.x+=n.vx; n.y+=n.vy;
      if(n.x<0||n.x>W) n.vx*=-1; if(n.y<0||n.y>H) n.vy*=-1;
    });
  }
  function loop() { draw(); requestAnimationFrame(loop); }
  window.addEventListener('resize', () => { resize(); initNodes(); });
  resize(); initNodes(); loop();
})();

/* ── Navbar Scroll ── */
window.addEventListener('scroll', function() {
  document.getElementById('mainNav').classList.toggle('scrolled', window.scrollY > 40);
  const sections = ['home','try-it','about','how-it-works','contact'];
  let current = 'home';
  sections.forEach(id => { const el=document.getElementById(id); if(el && window.scrollY>=el.offsetTop-120) current=id; });
  history.replaceState(null,'','#'+current);
  updateActiveNavLink('#'+current);
});

function closeMobileMenu() {
  const menu = document.getElementById('mobileMenu');
  const bsC  = bootstrap.Collapse.getInstance(menu);
  if (bsC) bsC.hide();
}

/* ── Carousal ── */
let currentCard = 0;
const cardCount  = 3;
function goToCard(idx) {
  const cards = document.querySelectorAll('.demo-card');
  const dots  = document.querySelectorAll('.c-dot');
  cards.forEach((c,i) => {
    c.classList.remove('active','behind1','behind2','exit-left');
    const rel = (i-idx+cardCount)%cardCount;
    if(rel===0) c.classList.add('active');
    else if(rel===1) c.classList.add('behind1');
    else if(rel===2) c.classList.add('behind2');
    else c.classList.add('exit-left');
  });
  dots.forEach((d,i) => d.classList.toggle('active',i===idx));
  currentCard = idx;
}
document.querySelectorAll('.demo-card').forEach(card => { card.addEventListener('click', () => goToCard((currentCard+1)%cardCount)); });
let touchStartX = 0;
const carousel  = document.getElementById('demoCarousel');
carousel.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
carousel.addEventListener('touchend',   e => { const dx=e.changedTouches[0].clientX-touchStartX; if(Math.abs(dx)>40) goToCard((currentCard+(dx<0?1:-1)+cardCount)%cardCount); });
setInterval(() => goToCard((currentCard+1)%cardCount), 4500);

/* ── AGENT FLOW ANIMATION ── */
const flowNodes = ['nodeUser','nodeFlight','nodeHotel','nodeItinerary','nodeResponse','nodeOutput'];
let flowIdx = 0;
setInterval(() => {
  document.querySelectorAll('.agent-node').forEach(n => n.classList.remove('active-node'));
  document.getElementById(flowNodes[flowIdx])?.classList.add('active-node');
  flowIdx = (flowIdx+1)%flowNodes.length;
}, 1000);

/* ── SCROLL REVEAL ── */
const revealEls = document.querySelectorAll('.reveal');
const observer  = new IntersectionObserver(entries => {
  entries.forEach(e => { if(e.isIntersecting) { e.target.classList.add('visible'); observer.unobserve(e.target); } });
}, { threshold: 0.1 });
revealEls.forEach(el => observer.observe(el));

/* ── Toast ── */
function showToast(msg) {
  const toast = document.getElementById('ts-toast');
  document.getElementById('toastMsg').textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

/* ── Init── */
(async function init() {
  await fetchSession();
  window.SESSION = SESSION;        // ensure window reference is updated
  window._sessionReady = true;     // signal mobile layer
  renderAuthUI();
  applyHashRoute();

  const params = new URLSearchParams(window.location.search);
  if (params.get('mode') === 'qa') switchChatTab('qa');
})();
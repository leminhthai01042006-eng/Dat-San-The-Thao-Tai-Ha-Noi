const byId = (id) => document.getElementById(id);
const coverProgress = byId('cover-progress');
const coverButtons = [...coverProgress.querySelectorAll('button')];
const coverSlides = byId('hero').querySelectorAll('.cover-slide');
const coverCopy = byId('hero').querySelectorAll('.cover-copy > div');
// Index 0 is the volleyball photo underneath the other backgrounds.
let coverIndex = 0;

function syncCoverProgress() {
  coverProgress.style.setProperty('--cover-timer-state', document.hidden ? 'paused' : 'running');
}

function showCover(index) {
  if (index === coverIndex) return;
  coverButtons[coverIndex].removeAttribute('aria-current');
  coverIndex = index;
  coverButtons[index].setAttribute('aria-current', 'true');
  coverSlides.forEach((slide, index) => slide.classList.toggle('is-visible', coverIndex === index + 1));
  coverCopy.forEach((panel, index) => { panel.inert = coverIndex !== index; });
}

coverButtons.forEach((button, index) => {
  button.addEventListener('click', () => showCover(index));
});
coverProgress.addEventListener('animationend', event => {
  if (event.animationName === 'cover-progress-fill' && coverButtons[coverIndex].contains(event.target)) {
    showCover((coverIndex + 1) % coverButtons.length);
  }
});
document.addEventListener('visibilitychange', syncCoverProgress);
syncCoverProgress();

if ('IntersectionObserver' in window) {
  const revealSections = document.querySelectorAll([
    '#about .section-title', '.about-panel',
    '#why-us-title', '.why-us-intro', '.why-us-options details', '.why-us-visual',
    '#booking-comparison-title', '.comparison-card', '.comparison-summary',
    '#work-process .section-title', '.process-question', '.process-choices', '.process-panel',
    '#finder', '#results', '#sports .section-heading', '#sports .sport', 'footer .container',
  ].join(', '));
  const revealObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.remove('reveal-pending');
      revealObserver.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -12px 0px', threshold: 0.05 });

  for (const section of revealSections) {
    section.classList.add('scroll-reveal', 'reveal-pending');
    revealObserver.observe(section);
  }
}

const processChoices = byId('process-choices').querySelectorAll('button');
const workProcess = byId('work-process');
let courtCountsLoading = false;
let occupancyLoading = false;

processChoices.forEach(choice => {
  choice.addEventListener('click', () => {
    const playerSelected = choice.getAttribute('aria-controls') === 'process-player';
    workProcess.classList.add('has-active-role');
    workProcess.classList.toggle('is-player-view', playerSelected);
    workProcess.classList.toggle('is-owner-view', !playerSelected);
    processChoices.forEach(option => {
      const selected = option === choice;
      option.setAttribute('aria-pressed', String(selected));
      byId(option.getAttribute('aria-controls')).inert = !selected;
    });
    if (playerSelected) loadCourtCounts();
    else loadCourtOccupancy();
  });
});

const finder = byId('finder');
const startFinder = byId('start-finder');
startFinder.addEventListener('click', () => {
  byId('finder-area').hidden = false;
  startFinder.setAttribute('aria-expanded', 'true');
  finder.scrollIntoView({block:'center'});
  finder.elements.sport.focus({preventScroll:true});
});

const panel = byId('panel');
const body = byId('panel-body');
const feedback = byId('feedback');
const account = byId('account');
const matches = byId('matches');
const money = new Intl.NumberFormat('vi-VN', {style:'currency', currency:'VND'});
let user = null;
let searchVersion = 0;
let panelVersion = 0;

function vnDate(offsetDays = 0) {
  return new Date(Date.now() + (7 + 24 * offsetDays) * 3600000).toISOString().slice(0,10);
}
finder.elements.date.min = vnDate();
finder.elements.date.value = vnDate(1);

async function api(path, data) {
  const options = data === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)};
  const response = await fetch('/api' + path, options);
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || 'Chưa thể kết nối dịch vụ. Vui lòng thử lại.');
  return json;
}
function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

async function loadCourtCounts() {
  if (courtCountsLoading) return;
  courtCountsLoading = true;
  const status = byId('court-chart-status');
  const bars = byId('court-chart-bars');
  status.textContent = 'Đang tải số liệu…';
  bars.replaceChildren();
  try {
    const { total, sports } = await api('/facilities/court-counts');
    const bySport = new Map(sports.map(({ sport_code, name, court_count }) => [
      sport_code, { name, count: Number(court_count) },
    ]));
    for (const { value, textContent } of finder.elements.sport.options) {
      if (!value) continue;
      bySport.set(value, { name: textContent, count: bySport.get(value)?.count ?? 0 });
    }
    const rows = [...bySport.values()].sort((a, b) => b.count - a.count);
    status.textContent = `Tổng cộng ${total} sân`;
    const max = Math.max(1, ...rows.map(sport => sport.count));
    for (const { name, count } of rows) {
      const item = el('li');
      const label = el('div', undefined, 'court-chart-label');
      label.append(el('span', name), el('strong', String(count)));
      const track = el('div', undefined, 'court-chart-track');
      track.setAttribute('aria-hidden', 'true');
      const fill = el('span');
      fill.style.setProperty('--court-bar-width', `${100 * count / max}%`);
      track.append(fill);
      item.append(label, track);
      bars.append(item);
    }
  } catch (error) {
    status.textContent = error.message;
  } finally {
    courtCountsLoading = false;
  }
}

async function loadCourtOccupancy() {
  if (occupancyLoading) return;
  occupancyLoading = true;
  const status = byId('occupancy-status');
  const content = byId('occupancy-content');
  status.textContent = 'Đang tải tình trạng sân…';
  content.hidden = true;
  try {
    const { total, occupied, available } = await api('/facilities/court-occupancy');
    if (!total) {
      status.textContent = 'Hiện chưa có sân đang nhận đặt trên hệ thống.';
      return;
    }
    const occupiedPercent = Math.round(occupied * 100 / total);
    byId('occupancy-donut').style.setProperty('--occupied-share', `${occupied * 100 / total}%`);
    byId('occupancy-booked').textContent = `${occupied} sân · ${occupiedPercent}%`;
    byId('occupancy-free').textContent = `${available} sân · ${100 - occupiedPercent}%`;
    status.textContent = `${total} sân đang nhận đặt trên hệ thống`;
    content.hidden = false;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    occupancyLoading = false;
  }
}
function button(text, action, cls = 'action') {
  const node = el('button', text, cls);
  node.type = 'button';
  node.onclick = action;
  return node;
}
function openPanel(title) {
  panelVersion++;
  byId('panel-title').textContent = title;
  body.replaceChildren();
  feedback.textContent = '';
  if (!panel.open) panel.showModal();
}
byId('close').onclick = () => panel.close();
panel.addEventListener('close', () => panelVersion++);
function setUser(value) {
  user = value;
  account.querySelector('span').textContent = user?.full_name || 'Đăng nhập';
}
function auth(then, register = false) {
  openPanel(register ? 'Tạo tài khoản người chơi' : 'Đăng nhập');
  const form = el('form');
  const fields = register ? [['Họ và tên','full_name','text','name'],['Số điện thoại','phone','tel','tel']] : [];
  fields.push(['Email','email','email','email'],['Mật khẩu','password','password',register ? 'new-password':'current-password']);
  for (const [title,name,type,autocomplete] of fields) {
    const label = el('label',title);
    const input = el('input');
    Object.assign(input,{name,type,autocomplete,required:true});
    label.append(input);
    form.append(label);
  }
  const submit = el('button',register ? 'Tạo tài khoản' : 'Đăng nhập','action');
  form.append(submit);
  body.append(form,button(register ? 'Đã có tài khoản? Đăng nhập' : 'Tạo tài khoản mới',()=>auth(then,!register),'text-btn'));
  form.onsubmit = async event => {
    event.preventDefault();
    submit.disabled = true;
    const values = Object.fromEntries(new FormData(form));
    try {
      if (register) await api('/auth/register',values);
      setUser(await api('/auth/login',{email:values.email,password:values.password}));
      if (then) then(); else panel.close();
    } catch (error) { feedback.textContent = error.message; }
    finally { submit.disabled = false; }
  };
}
account.onclick = () => {
  if (!user) return auth();
  openPanel(user.full_name);
  body.append(el('p',user.email),button('Đăng xuất',async () => {
    try { await api('/auth/logout',{}); setUser(null); panel.close(); }
    catch (e) { feedback.textContent = e.message; }
  }));
};
api('/auth/me').then(setUser).catch(()=>{});
async function historyPanel() {
  if (!user) return auth(historyPanel);
  openPanel('Lịch của tôi');
  const version = panelVersion;
  feedback.textContent = 'Đang tải lịch…';
  const states = {Pending:'Chờ xử lý',Cancelled:'Đã hủy',Expired:'Hết hạn',Fully_Paid:'Đã thanh toán',Deposit_Paid:'Đã đặt cọc',Completed:'Hoàn thành'};
  try {
    const bookings = await api('/bookings/me');
    if (version !== panelVersion) return;
    feedback.textContent = bookings.length ? '' : 'Bạn chưa có lịch đặt sân.';
    for (const row of bookings) {
      const card = el('article',undefined,'item');
      const details = el('div');
      details.append(el('strong',row.court_name),el('p',row.facility_name),el('p',row.start_time+' · '+(states[row.status] || row.status)));
      card.append(details);
      if (row.status === 'Pending') card.append(button('Hủy lịch',() => {
        openPanel('Hủy lịch đặt sân?');
        body.append(el('p',row.court_name+' · '+row.start_time),button('Giữ lịch',historyPanel,'text-btn'),button('Xác nhận hủy',async event=>{
          const trigger = event.currentTarget; trigger.disabled = true;
          try { await api('/bookings/'+row.booking_id+'/cancel',{}); await historyPanel(); }
          catch (e) { feedback.textContent=e.message; trigger.disabled=false; }
        }));
      },'text-btn'));
      body.append(card);
    }
  } catch(e) { if(version===panelVersion) feedback.textContent=e.message; }
}
byId('history').onclick = historyPanel;
function reserve(court, slot) {
  if (!user) return auth(()=>reserve(court,slot));
  openPanel('Xác nhận đặt sân');
  const submit = button('Đặt sân',async () => {
    submit.disabled=true;
    try {
      const booking = await api('/bookings',{court_id:Number(court.court_id),start_time:slot.start,end_time:slot.end});
      openPanel('Đã tạo đơn đặt sân');
      body.append(el('p',court.court_name+' · '+slot.start),el('p','Mã đơn: '+booking.booking_code),button('Xem lịch của tôi',historyPanel));
      finder.requestSubmit();
    } catch(e) { feedback.textContent=e.message; submit.disabled=false; }
  });
  body.append(el('strong',court.court_name+' · '+court.facility_name),el('p',slot.start+' – '+slot.end.slice(11)),el('p','Tiền sân: '+money.format(Number(court.price_per_hour)*slot.minutes/60)));
  if(court.cancel_before_minutes!=null) body.append(el('p','Hạn hủy trước giờ chơi: '+court.cancel_before_minutes+' phút.'));
  body.append(submit);
}
finder.onsubmit = async event => {
  event.preventDefault();
  const version = ++searchVersion;
  const fields = finder.elements;
  const start = fields.date.value+' '+fields.time.value;
  const instant = Date.parse(start.replace(' ','T')+':00+07:00');
  const minutes = Number(fields.minutes.value);
  const end = new Date(instant+(minutes+420)*60000).toISOString().slice(0,16).replace('T',' ');
  const slot = {start,end,minutes};
  byId('results').hidden=false;
  if(!panel.open) byId('results').scrollIntoView({block:'start'});
  if (instant<=Date.now()) { matches.textContent='Hãy chọn giờ bắt đầu trong tương lai.'; return; }
  matches.textContent='Đang tìm sân…';
  const query = new URLSearchParams({start_time:start,end_time:end});
  if(fields.sport.value) query.set('sport_type',fields.sport.value);
  try {
    const rows = await api('/facilities/search?'+query);
    if (version!==searchVersion) return;
    matches.textContent=rows.length ? '' : 'Chưa có sân trống. Bạn có thể đổi môn hoặc khung giờ.';
    for(const court of rows) {
      const details=el('div');
      details.append(el('strong',court.court_name+' · '+court.facility_name),el('p',court.address+' · '+court.district),el('p',money.format(court.price_per_hour)+'/giờ'));
      const card=el('article',undefined,'item');
      card.append(details,button('Chọn sân',()=>reserve(court,slot)));
      matches.append(card);
    }
  } catch(e) { if(version===searchVersion) matches.textContent=e.message; }
};
const sportMenu = byId('sport-menu');
document.addEventListener('click', event => {
  if (!sportMenu.contains(event.target)) sportMenu.open = false;
});
sportMenu.addEventListener('keydown', event => {
  if (event.key === 'Escape' && sportMenu.open) {
    sportMenu.open = false;
    sportMenu.querySelector('summary').focus();
  }
});
for(const option of document.querySelectorAll('[data-sport]')) option.onclick=()=>{
  sportMenu.open = false;
  finder.elements.sport.value=option.dataset.sport;
  if (finder.closest('[hidden]')) {
    sportMenu.querySelector('summary').focus();
    return;
  }
  finder.scrollIntoView({block:'center'});
  finder.elements.date.focus({preventScroll:true});
};

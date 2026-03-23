const API_URL = "https://dev-sni-admin.eyevacs.com";
const LOGIN_ID = "alstn5632";
const LOGIN_PW = "mirero2816!";
const SITE_ID = "SBI_EYEVACS_0032";
const VEHICLES = ["16마1011", "127조9937", "328서3376"];

const COUPON_DURATION = {
  "66860826a0b22bef3d9d9a5d": 1440,
  "6690d11bebc44ff5ad7ff7a6": 30,
  "6690d12d2532bf9ca77f06ef": 60,
  "668608551b46b9842cc665a1": 60,
  "6690e5b8ebc44ff5ad8a1713": 120,
  "67ee2428eff0590c0b760edc": 180,
  "668608911b46b9842cc6835f": 240,
};

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_USERS = ["U0AE6FTUWQ0", "U0ADA5TB3TQ", "U0AE046CVLJ"];

async function apiRequest(method, path, token, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (token) opts.headers["Authorization"] = `Bearer ${token}`;
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(API_URL + path, opts);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.substring(0, 200)}`);
  }
  return resp.json();
}

async function login() {
  const data = await apiRequest("POST", "/auth/token", null, { id: LOGIN_ID, password: LOGIN_PW });
  return data.access_token;
}

function parseDt(iso) { return new Date(iso); }
function toIso(dt) { return dt.toISOString().replace(/\.\d{3}Z$/, ".000Z"); }
function randInt(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }

function kstStr(dt) {
  const d = dt.toLocaleDateString("ko-KR", { month: "2-digit", day: "2-digit", timeZone: "Asia/Seoul" });
  const t = dt.toLocaleTimeString("ko-KR", { hour12: false, hour: "2-digit", minute: "2-digit", timeZone: "Asia/Seoul" });
  return `${d} ${t}`;
}

function getTodayKst() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function getCouponMaxMinutes(va) {
  const coupons = (va.payment || {}).discountCouponList || [];
  let max = 0;
  for (const cp of coupons) {
    const key = cp.discountCouponKey || {};
    const keyId = typeof key === "object" ? (key._id || "") : String(key);
    const dur = COUPON_DURATION[keyId] || 0;
    if (dur > max) max = dur;
  }
  return max;
}

async function cleanupRecord(token, va) {
  const vaId = va._id;
  const vehicle = va.vehicle;
  const created = parseDt(va.createdAt);
  const oldEntry = parseDt(va.entry.accessedAt);
  const oldExit = va.exit ? parseDt(va.exit.accessedAt) : null;
  const entryFac = va.entry.facility._id;
  const exitFac = va.exit && va.exit.facility ? va.exit.facility._id : entryFac.replace("entrance", "exit");

  const newEntry = new Date(created.getTime() + 60000);
  await apiRequest("PATCH", `/vehicle-accesses/${vaId}`, token, {
    entry: { accessedAt: toIso(newEntry), facility: entryFac }
  });

  const couponMin = getCouponMaxMinutes(va);
  let parkMin;
  if (couponMin > 0) { parkMin = couponMin - randInt(10, 20); }
  else { parkMin = randInt(20, 25); }
  let newExit = new Date(newEntry.getTime() + parkMin * 60000);

  const entryUtcDate = newEntry.toISOString().slice(0, 10);
  const exitUtcDate = newExit.toISOString().slice(0, 10);
  if (exitUtcDate !== entryUtcDate) {
    const midnight = new Date(newEntry);
    midnight.setUTCHours(23, 50 + randInt(0, 5), randInt(0, 59), 0);
    newExit = midnight;
    parkMin = Math.round((newExit - newEntry) / 60000);
    console.log(`  ${vehicle}: UTC 날짜 경계 보정`);
  }

  await apiRequest("PATCH", `/vehicle-accesses/${vaId}`, token, {
    exit: { accessedAt: toIso(newExit), facility: exitFac }
  });

  const info = `입차 ${kstStr(oldEntry)} -> ${kstStr(newEntry)} | 출차 ${oldExit ? kstStr(oldExit) : "?"} -> ${kstStr(newExit)} (${couponMin > 0 ? "쿠폰" + couponMin + "분" : "무료"}, ${parkMin}분)`;
  console.log(`  ${vehicle}: ${info}`);
  return info;
}

async function sendSlack(message) {
  if (!SLACK_TOKEN) {
    console.log("SLACK_BOT_TOKEN 미설정 - 알림 생략");
    return;
  }
  for (const userId of SLACK_USERS) {
    try {
      const openResp = await fetch("https://slack.com/api/conversations.open", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SLACK_TOKEN}`
        },
        body: JSON.stringify({ users: userId })
      });
      const openData = await openResp.json();
      if (!openData.ok) {
        console.log(`Slack DM 열기 실패 (${userId}): ${openData.error}`);
        continue;
      }
      const channel = openData.channel.id;
      const resp = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SLACK_TOKEN}`
        },
        body: JSON.stringify({ channel, text: message })
      });
      const data = await resp.json();
      if (!data.ok) console.log(`Slack 전송 실패 (${userId}): ${data.error}`);
    } catch (e) {
      console.log(`Slack 전송 오류 (${userId}): ${e.message}`);
    }
  }
}

async function main() {
  console.log("=== 오늘 주차기록 정리 시작 ===");
  const token = await login();
  console.log("로그인 성공");

  const today = getTodayKst();
  console.log(`정리 대상 날짜: ${today} (KST)`);

  const cleaned = [];
  let total = 0;

  for (const vehicle of VEHICLES) {
    const data = await apiRequest("GET",
      `/vehicle-accesses?siteId=${SITE_ID}&vehicle=${encodeURIComponent(vehicle)}&page=1&count=50`, token);

    const targets = [];
    for (const va of (data.vehicleAccesses || [])) {
      const created = parseDt(va.createdAt);
      const createdKst = created.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
      if (createdKst !== today) continue;
      if (va.status === "inParking") continue;
      const entryAt = parseDt(va.entry.accessedAt);
      const diffMin = Math.abs(created - entryAt) / 60000;
      if (diffMin >= 2) {
        console.log(`  ${vehicle}: 정리 대상 (생성↔입차 ${Math.round(diffMin)}분)`);
        targets.push(va);
      }
    }

    if (!targets.length) {
      console.log(`${vehicle}: 정리 대상 없음`);
      continue;
    }

    for (const va of targets) {
      try {
        const info = await cleanupRecord(token, va);
        cleaned.push(`${va.vehicle}: ${info}`);
        total++;
      } catch (e) {
        console.log(`${vehicle} 정리 오류: ${e.message}`);
      }
    }
  }

  if (cleaned.length > 0) {
    const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    const msg = `[주차 기록 정리] ${now}\n정리 완료 ${total}건:\n${cleaned.map(v => `- ${v}`).join("\n")}`;
    await sendSlack(msg);
  }

  console.log(`=== 완료 (${total}건) ===`);
}

main().catch(e => { console.error("오류:", e.message); process.exit(1); });

const API_URL = "https://dev-sni-admin.eyevacs.com";
const LOGIN_ID = "alstn5632";
const LOGIN_PW = "mirero2816!";
const SITE_ID = "SBI_EYEVACS_0032";
const PAGE_URL = "https://wangbearstory.github.io/parking-coupon/change-entry.html";

const OWNER_ID = "66a9c4f0c920064e4a47abc9";
const COUPON_KEY_2H = "6690e5b8ebc44ff5ad8a1713";

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const FORCE_RUN = String(process.env.FORCE_RUN || "").toLowerCase() === "true";

// 이벤트 실행 가능 시각(KST). 이 시각 전에는 확인만 하고 실행하지 않는다.
const WINDOW_START_HOUR = 15;
// 퇴근 시각(KST). 지연 배달된 트리거가 늦은 시각에 입차시간을 덮어쓰지 않도록 이 시각부터는 실행하지 않는다.
const WINDOW_END_HOUR = 18;
// 입차시간이 오늘 이 시각(KST, 분 단위) 이후로 잡혀 있고 무료쿠폰까지 붙어 있으면 오늘 이벤트가 이미 실행된 것으로 본다.
// 이벤트는 15시 이후에만 실행되고 입차시간을 현재-6~10분으로 잡으므로 실행 결과는 항상 14:50 이후가 된다.
const DONE_THRESHOLD_MINUTES = 14 * 60 + 45;

// 사용자별 차량 매핑
const CHANNEL_VEHICLES = [
  { channel: "U0ADA5TB3TQ", vehicle: "127조9937" },
  { channel: "U0AE6FTUWQ0", vehicle: "16마1011" },
  { channel: "U0AE046CVLJ", vehicle: "328서3376" },
];

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

function toIso(dt) { return dt.toISOString().replace(/\.\d{3}Z$/, ".000Z"); }
function pad(n) { return String(n).padStart(2, "0"); }
// UTC 기준 Date 를 KST 달력값으로 분해 (러너는 UTC 로 동작)
function kstParts(dt = new Date()) {
  const k = new Date(dt.getTime() + 9 * 60 * 60 * 1000);
  return { y: k.getUTCFullYear(), m: k.getUTCMonth(), d: k.getUTCDate(), hour: k.getUTCHours(), minute: k.getUTCMinutes() };
}
function kstStr(dt) {
  return dt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

// 입차시간을 현재 시각 6~10분 전으로 랜덤 보정 (쿠폰 applyAt 과의 자연스러운 시간차 확보)
function pickEntryTime() {
  const offsetMs = (6 + Math.random() * 4) * 60 * 1000;
  return new Date(Date.now() - offsetMs);
}

async function getVehicleByStatus(token, vehicle, status) {
  const data = await apiRequest("GET",
    `/vehicle-accesses?siteId=${SITE_ID}&vehicle=${encodeURIComponent(vehicle)}&status=${status}`, token);
  const items = data.vehicleAccesses || [];
  return items.length ? items[0] : null;
}

async function patchEntryTime(token, va, nowIso) {
  const facility = va.entry.facility._id;
  await apiRequest("PATCH", `/vehicle-accesses/${va._id}`, token, {
    entry: { accessedAt: nowIso, facility }
  });
}

function hasFreeCoupon(va) {
  const coupons = (va.payment || {}).discountCouponList || [];
  return coupons.some(cp => {
    const key = cp.discountCouponKey || {};
    return typeof key === "object" && (key.name || "").includes("방문자확인");
  });
}

// 오늘 이벤트가 이미 실행됐는지 판정: 입차시간이 오늘 14:45 이후로 당겨져 있고 무료쿠폰이 붙어 있으면 처리 완료
function isProcessedToday(va) {
  const accessedAt = ((va.entry || {}).accessedAt) || null;
  if (!accessedAt) return false;
  const now = kstParts();
  const a = kstParts(new Date(accessedAt));
  const sameDay = a.y === now.y && a.m === now.m && a.d === now.d;
  return sameDay && a.hour * 60 + a.minute >= DONE_THRESHOLD_MINUTES && hasFreeCoupon(va);
}

async function getNextCoupon(token) {
  const data = await apiRequest("GET",
    `/discount-coupon-keys/coupon?owner=${OWNER_ID}&ownerModel=Admin`, token);
  for (const key of (data.discountCouponKeys || [])) {
    if (key._id === COUPON_KEY_2H) return { nextCoupon: key.nextCoupon, count: key.count || 0 };
  }
  return { nextCoupon: null, count: 0 };
}

async function applyCoupon(token, va, couponId) {
  let detail = await apiRequest("GET", `/vehicle-accesses/${va._id}`, token);
  if (detail.vehicleAccess) detail = detail.vehicleAccess;
  const existing = ((detail.payment || {}).discountCouponList || []).map(cp => cp._id);
  existing.push(couponId);
  await apiRequest("PATCH", `/vehicle-accesses/${va._id}`, token, {
    payment: { discountCouponList: existing }
  });
}

// 적용된 2시간무료(방문자확인) 쿠폰만 해제 (다른 쿠폰은 유지)
async function removeFreeCoupons(token, vaId) {
  let detail = await apiRequest("GET", `/vehicle-accesses/${vaId}`, token);
  if (detail.vehicleAccess) detail = detail.vehicleAccess;
  const kept = ((detail.payment || {}).discountCouponList || [])
    .filter(cp => !((cp.discountCouponKey || {}).name || "").includes("방문자확인"))
    .map(cp => cp._id);
  await apiRequest("PATCH", `/vehicle-accesses/${vaId}`, token, {
    payment: { discountCouponList: kept }
  });
}

async function sendSlack(channel, text) {
  if (!SLACK_TOKEN) {
    console.log("SLACK_BOT_TOKEN 미설정 - 알림 생략");
    return;
  }
  try {
    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SLACK_TOKEN}`
      },
      body: JSON.stringify({ channel, text })
    });
    const data = await resp.json();
    if (!data.ok) console.log(`Slack 전송 실패 (${channel}): ${data.error}`);
    else console.log(`Slack 전송 성공 (${channel})`);
  } catch (e) {
    console.log(`Slack 전송 오류 (${channel}): ${e.message}`);
  }
}

// 입차중인 차량의 입차시간을 자동 변경하고 2시간무료 쿠폰을 적용 (페이지의 onBoth 동작과 동일)
async function processVehicle(token, va) {
  const newEntry = pickEntryTime();
  await patchEntryTime(token, va, toIso(newEntry));

  // 쿠폰: 이미 적용돼 있으면 해제 후 재등록, 없으면 신규 등록
  const wasApplied = hasFreeCoupon(va);
  if (wasApplied) await removeFreeCoupons(token, va._id);

  let couponMsg;
  const { nextCoupon, count } = await getNextCoupon(token);
  if (!nextCoupon) {
    couponMsg = "2시간무료 쿠폰 잔여가 없어 시간만 변경했습니다.";
  } else {
    await applyCoupon(token, va, nextCoupon);
    couponMsg = wasApplied
      ? `2시간무료 쿠폰이 재등록되었습니다. (잔여 ${count - 1})`
      : `2시간무료 쿠폰이 적용되었습니다. (잔여 ${count - 1})`;
  }

  return { newEntry, couponMsg };
}

async function main() {
  const now = kstParts();
  const nowLabel = `${pad(now.hour)}:${pad(now.minute)} KST`;
  const beforeWindow = now.hour < WINDOW_START_HOUR;
  const afterWindow = now.hour >= WINDOW_END_HOUR;

  console.log(`=== 입차시간 자동 변경 + 쿠폰 적용 확인 (현재 ${nowLabel}) ===`);
  if (FORCE_RUN) console.log("강제 실행 모드 - 시간/중복 확인 무시");
  else if (beforeWindow) console.log(`${WINDOW_START_HOUR}시 이전이라 상태 확인만 하고 이벤트는 실행하지 않습니다.`);
  else if (afterWindow) console.log(`${WINDOW_END_HOUR}시 이후(퇴근)라 상태 확인만 하고 이벤트는 실행하지 않습니다.`);

  const token = await login();
  console.log("로그인 성공");

  for (const { channel, vehicle } of CHANNEL_VEHICLES) {
    let attempted = false;
    try {
      const va = await getVehicleByStatus(token, vehicle, "inParking");
      if (!va) {
        console.log(`${vehicle}: 미입차 - 스킵`);
        continue;
      }

      if (!FORCE_RUN && isProcessedToday(va)) {
        console.log(`${vehicle}: 오늘 이벤트 이미 실행됨(입차 ${kstStr(new Date(va.entry.accessedAt))}) - 스킵`);
        continue;
      }

      if (!FORCE_RUN && beforeWindow) {
        console.log(`${vehicle}: 미실행 상태 - ${WINDOW_START_HOUR}시 이후 트리거에서 실행 예정`);
        continue;
      }

      if (!FORCE_RUN && afterWindow) {
        console.log(`${vehicle}: 미실행 상태 - ${WINDOW_END_HOUR}시 이후라 오늘은 실행하지 않습니다.`);
        continue;
      }

      attempted = true;
      const result = await processVehicle(token, va);
      const msg = `[${vehicle}] 입차시간이 ${kstStr(result.newEntry)}(으)로 변경되었습니다.
${result.couponMsg}`;
      await sendSlack(channel, msg);
      console.log(`${vehicle}: 자동 처리 완료`);
    } catch (e) {
      console.log(`${vehicle}: 처리 실패 - ${e.message}`);
      if (!attempted) continue; // 실행 전(조회/판정) 오류는 다음 트리거에서 재시도
      const link = `${PAGE_URL}?vehicle=${encodeURIComponent(vehicle)}`;
      const msg = `[${vehicle}] 입차시간 자동 변경에 실패했습니다. 아래에서 직접 변경해 주세요.
${link}`;
      await sendSlack(channel, msg);
    }
  }

  console.log("=== 완료 ===");
}

main().catch(e => { console.error("오류:", e.message); process.exit(1); });
